import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, getToolUiResourceUri, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import "./style.css";

/**
 * A stand-in MCP Apps host for building the screens: it connects to this
 * server's /mcp as a client, calls show_today, and renders the Today screen in
 * a sandboxed frame the size of an Echo Show, the way Alexa+ would.
 */

const deviceEl = document.getElementById("device") as HTMLSelectElement;
const themeEl = document.getElementById("theme") as HTMLSelectElement;
const actualEl = document.getElementById("actual") as HTMLInputElement;
const frameEl = document.getElementById("frame")!;
const stageEl = document.getElementById("stage")!;
const logEl = document.getElementById("log")!;

const client = new Client({ name: "corral-preview", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.origin)));
const { tools } = await client.listTools();
const tool = tools.find((t) => t.name === "show_today")!;
const uri = getToolUiResourceUri(tool)!;
const resource = await client.readResource({ uri });
const html = (resource.contents[0] as { text: string }).text;

let bridge: AppBridge | null = null;
/** Inline sits under a strip where the assistant's words would be; full screen is the whole display. */
let displayMode: "inline" | "fullscreen" = "inline";

function size(): { width: number; height: number } {
  const [width, height] = deviceEl.value.split("x").map(Number) as [number, number];
  return { width, height };
}

function context() {
  const { width, height } = size();
  return {
    theme: themeEl.value as "light" | "dark",
    displayMode,
    availableDisplayModes: ["inline" as const, "fullscreen" as const],
    containerDimensions: { width, height },
    platform: "web" as const,
    locale: "en-US",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    deviceCapabilities: { touch: true, hover: false },
  };
}

/** Fits the device frame in the window, scaled down when it's bigger, unless it's shown at actual size. */
function fit() {
  const { width, height } = size();
  const scale = actualEl.checked ? 1 : Math.min(1, (stageEl.clientWidth - 24) / width, (stageEl.clientHeight - 24) / height);
  stageEl.classList.toggle("actual", actualEl.checked);
  frameEl.style.width = `${width}px`;
  frameEl.style.height = `${height}px`;
  frameEl.style.transform = scale < 1 ? `scale(${scale})` : "";
}

async function mount() {
  await bridge?.close().catch(() => {});
  frameEl.replaceChildren();
  const iframe = document.createElement("iframe");
  iframe.title = "Today";
  iframe.setAttribute("sandbox", "allow-scripts");
  const strip = document.createElement("p");
  strip.className = "said";
  strip.textContent = "Here's today.";
  frameEl.append(strip, iframe);
  frameEl.classList.toggle("fullscreen", displayMode === "fullscreen");
  bridge = new AppBridge(client, { name: "Corral preview", version: "0.1.0" }, { serverTools: {}, logging: {}, updateModelContext: { text: {} } }, { hostContext: context() });
  bridge.oninitialized = async () => {
    const result = await client.callTool({ name: "show_today", arguments: {} });
    await bridge!.sendToolInput({ arguments: {} });
    await bridge!.sendToolResult(result as Parameters<AppBridge["sendToolResult"]>[0]);
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    if (mode === "inline" || mode === "fullscreen") displayMode = mode;
    frameEl.classList.toggle("fullscreen", displayMode === "fullscreen");
    void bridge?.sendHostContextChange({ displayMode });
    return { mode: displayMode };
  };
  bridge.onupdatemodelcontext = async (params) => {
    for (const c of params.content ?? []) {
      if (c.type !== "text") continue;
      const li = document.createElement("li");
      li.textContent = c.text;
      logEl.prepend(li);
    }
    return {};
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  iframe.srcdoc = html;
  fit();
}

deviceEl.addEventListener("change", () => {
  fit();
  void bridge?.sendHostContextChange(context());
});
themeEl.addEventListener("change", () => void bridge?.sendHostContextChange({ theme: themeEl.value as "light" | "dark" }));
actualEl.addEventListener("change", fit);
document.getElementById("reload")!.addEventListener("click", () => void mount());
addEventListener("resize", fit);
await mount();
