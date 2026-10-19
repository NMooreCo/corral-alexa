import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/server";

/**
 * What every Corral screen shares: connecting to the host, following its
 * theme, fonts, safe areas and display mode, keeping itself current while
 * it's on screen (and stopping when it isn't, or when the host tears it
 * down), telling the assistant what a tap did, and small helpers for words.
 */

export interface ScreenOptions<V> {
  name: string;
  /** Reads a tool result into this screen's view, or null when it isn't one. */
  read(result: CallToolResult): V | null;
  /** Draws the view. Called again whenever the view, the host or the clock changes. */
  render(view: V): void;
  /** Fetches a fresh view; called every refreshMs while the screen is visible. */
  refresh?(): Promise<CallToolResult>;
  refreshMs?: number;
}

export interface Screen<V> {
  app: App;
  view(): V | null;
  context(): McpUiHostContext | undefined;
  /** Shows a new result (from a tap, say) without waiting for the next refresh. */
  show(result: CallToolResult): void;
  rerender(): void;
  refreshNow(): Promise<void>;
  /** Calls a tool and says its refusal as a toast; resolves with the result text, or null if it failed. */
  act(name: string, args: Record<string, unknown>): Promise<string | null>;
  /** Tells the assistant what happened on the screen, with a small YAML header it can read. */
  tell(action: string, detail: Record<string, string>, sentence: string): void;
  toast(message: string): void;
  canFullscreen(): boolean;
  isFullscreen(): boolean;
  toggleFullscreen(): Promise<void>;
}

/**
 * How often a screen asks whether the household changed. The server is
 * stateless and can't push, so a change made anywhere (another Echo Show,
 * the assistant, a tap) reaches this screen through a cheap counter,
 * household_version, which only screens call; when it moves, the screen
 * refreshes. A server without the counter (one linked to a real Corral)
 * keeps the slower refresh alone.
 */
const SYNC_MS = 3_000;

/**
 * How far the household's clock is from this device's, from the `at` a view
 * carries. A simulator can run its household at another hour, and a screen's
 * clock, "now" and countdowns follow the household rather than the device.
 */
let skewMs = 0;

/** Now, by the household's clock. */
export function householdNow(): Date {
  return new Date(Date.now() + skewMs);
}

export async function startScreen<V>(opts: ScreenOptions<V>): Promise<Screen<V>> {
  const app = new App({ name: opts.name, version: "0.2.0" });
  let view: V | null = null;
  let context: McpUiHostContext | undefined;
  let visible = true;

  const toastEl = document.getElementById("toast") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "toast", hidden: true }));
  toastEl.setAttribute("role", "status");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (message: string) => {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 5000);
  };

  const rerender = () => view && opts.render(view);
  const show = (result: CallToolResult) => {
    const at = (result.structuredContent as { at?: unknown } | undefined)?.at;
    if (typeof at === "string" && !Number.isNaN(Date.parse(at))) skewMs = Date.parse(at) - Date.now();
    const v = opts.read(result);
    if (v) {
      view = v;
      rerender();
    }
  };

  const applyContext = (ctx: McpUiHostContext | undefined) => {
    if (!ctx) return;
    context = ctx;
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    document.documentElement.dataset.display = ctx.displayMode ?? "inline";
    if (ctx.safeAreaInsets) {
      const { top, right, bottom, left } = ctx.safeAreaInsets;
      document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
    }
    rerender();
  };

  const refreshNow = async () => {
    if (!opts.refresh) return;
    try {
      show(await opts.refresh());
    } catch {
      rerender();
    }
  };

  app.ontoolresult = (result) => show(result as CallToolResult);
  app.onhostcontextchanged = (ctx) => applyContext({ ...context, ...ctx });
  const timers: ReturnType<typeof setInterval>[] = [];
  const observer = new IntersectionObserver(([entry]) => {
    const was = visible;
    visible = entry?.isIntersecting ?? true;
    if (visible && !was) void refreshNow();
  });
  app.onteardown = async () => {
    timers.forEach(clearInterval);
    observer.disconnect();
    return {};
  };
  await app.connect();
  applyContext(app.getHostContext());

  const onScreen = () => visible && document.visibilityState === "visible";
  if (opts.refresh) timers.push(setInterval(() => onScreen() && void refreshNow(), opts.refreshMs ?? 60_000));

  // The household's change counter: the last one seen, whether this server has one, and how many asks in a row failed.
  let seen: number | undefined;
  let offered = true;
  let misses = 0;
  let skipped = 0;
  let syncing = false;
  const sync = async () => {
    if (!opts.refresh || !offered || syncing) return;
    // After a few failures in a row, ask about once a minute until it answers again.
    if (misses >= 3 && ++skipped % 20 !== 0) return;
    syncing = true;
    try {
      const res = await app.callServerTool({ name: "household_version", arguments: {} });
      const version = (res.structuredContent as { version?: unknown } | undefined)?.version;
      if (res.isError || typeof version !== "number") return void (offered = false);
      misses = 0;
      const changed = seen !== undefined && version !== seen;
      seen = version;
      if (changed) await refreshNow();
    } catch (err) {
      // A server without the counter says the tool isn't there (invalid params); anything else may pass.
      if ((err as { code?: unknown } | null)?.code === -32602) offered = false;
      else misses++;
    } finally {
      syncing = false;
    }
  };
  if (opts.refresh) {
    void sync();
    timers.push(setInterval(() => onScreen() && void sync(), SYNC_MS));
  }
  // Clocks and "now" move between refreshes.
  timers.push(setInterval(() => onScreen() && rerender(), 15_000));
  observer.observe(document.body);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void refreshNow());

  const canFullscreen = () => Boolean(context?.availableDisplayModes?.includes("fullscreen") && context.availableDisplayModes.includes("inline"));
  const isFullscreen = () => context?.displayMode === "fullscreen";

  return {
    app,
    view: () => view,
    context: () => context,
    show,
    rerender,
    refreshNow,
    async act(name, args) {
      try {
        const res = await app.callServerTool({ name, arguments: args });
        const said = res.content?.find((c) => c.type === "text");
        const text = said && "text" in said ? said.text : "";
        if (res.isError) {
          toast(text || "That didn't work.");
          return null;
        }
        return text;
      } catch {
        toast("That didn't work.");
        return null;
      }
    },
    tell(action, detail, sentence) {
      const yaml = Object.entries({ screen: opts.name, action, ...detail })
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
      void app.updateModelContext({ content: [{ type: "text", text: `---\n${yaml}\n---\n${sentence}` }] }).catch(() => {});
    },
    toast,
    canFullscreen,
    isFullscreen,
    async toggleFullscreen() {
      try {
        const { mode } = await app.requestDisplayMode({ mode: isFullscreen() ? "inline" : "fullscreen" });
        applyContext({ ...context, displayMode: mode });
      } catch {
        toast("This screen can't change size here.");
      }
    },
  };
}

// ---------- Words ----------

export function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function firstName(name: string): string {
  return name.split(" ")[0] ?? name;
}

/** Today as Corral labels days ("Fri, Oct 16"), in the host's time zone. */
export function todayLabel(timeZone?: string): string {
  return householdNow().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone });
}

/** Corral says times like "Fri, Oct 16, 3:30 PM"; today's own date is left off. */
export function withoutToday(label: string, timeZone?: string): string {
  const today = todayLabel(timeZone);
  if (label === today) return "Today";
  return label.startsWith(`${today}, `) ? label.slice(today.length + 2) : label;
}

/** The size button, when the host can switch between inline and full screen. */
export function sizeButton(screen: Screen<unknown>): string {
  return screen.canFullscreen() ? `<button type="button" class="size" data-action="fullscreen">${screen.isFullscreen() ? "Exit full screen" : "Full screen"}</button>` : "";
}
