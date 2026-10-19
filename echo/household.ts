/**
 * Which sample household this visitor works in. A link that names one
 * (?household=demo, or a teammate's) uses it; otherwise each browser gets one
 * of its own, kept here, so visitors can't change each other's demo: one
 * judge's "Make it evening" or "Next morning" never moves another's clock.
 * The id goes into the address, so copying the link shares the household
 * (a second device, the two-Echo-Show page, a teammate).
 */

const KEY = "corral-echo-household";
/** What the server takes as a household id: lowercase letters, digits and dashes, up to 40. */
const VALID = /^[a-z0-9-]{1,40}$/;

export function visitorHousehold(): string {
  const params = new URLSearchParams(location.search);
  const named = params.get("household");
  if (named && VALID.test(named)) return named;
  let id: string | null = null;
  try {
    id = localStorage.getItem(KEY);
  } catch {
    // Storage blocked (a private window, say): this visit gets its own.
  }
  if (!id || !VALID.test(id)) {
    id = `visit-${crypto.randomUUID().slice(0, 8)}`;
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // Kept for this visit only.
    }
  }
  params.set("household", id);
  history.replaceState(history.state, "", `${location.pathname}?${params}${location.hash}`);
  return id;
}
