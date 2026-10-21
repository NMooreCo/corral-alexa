import { describe, expect, it } from "vitest";
import { serveMcp } from "../src/http.ts";
import type { Ranch } from "../src/ranch/index.ts";
import type { RanchView } from "../src/ranch/views.ts";
import { SampleHousehold } from "../src/sample/index.ts";
import { sampleRanch } from "../src/sample/ranch.ts";
import type { TodayView } from "../src/today.ts";
import { railTabs } from "../widgets/home/rail.ts";

/**
 * The home screen's rail offers the ranch's tabs whenever the server has a
 * ranch, from Today's first answer, and never waits on the ranch's own read
 * (which a slow greenhouse controller or forecast can hold up for seconds).
 */

const tabs = (view: Parameters<typeof railTabs>[0]) => railTabs(view).map((t) => t.tab);
const EVERY = ["today", "ranch", "animals", "automations"];
const A_RANCH = { animals: { outside: [] } } as unknown as RanchView;

/** A screen tool's answer from a server for the sample household, with its ranch or without one. */
async function call(name: string, ranch?: Ranch) {
  const res = await serveMcp(
    new Request("https://bridge.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
    }),
    new SampleHousehold(),
    ranch,
  );
  const text = await res.text();
  // Answered as JSON or as a one-message event stream.
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).at(-1)!.slice(5) : text;
  return (JSON.parse(data) as { result: { content: { text: string }[]; structuredContent: TodayView } }).result;
}

describe("the home screen's rail", () => {
  it("offers the ranch's tabs as soon as Today says there's a ranch, before the ranch has answered", () => {
    expect(tabs({ tab: "today", today: { hasRanch: true }, ranch: null })).toEqual(EVERY);
  });

  it("offers them once the ranch has answered, or when the screen opened on one of its tabs", () => {
    expect(tabs({ tab: "today", today: null, ranch: A_RANCH })).toEqual(EVERY);
    for (const tab of ["ranch", "animals", "automations"] as const) expect(tabs({ tab, today: null, ranch: null })).toEqual(EVERY);
  });

  it("offers Today alone when nothing says there's a ranch", () => {
    expect(tabs({ tab: "today", today: null, ranch: null })).toEqual(["today"]);
    expect(tabs({ tab: "today", today: {}, ranch: null })).toEqual(["today"]);
    expect(tabs({ tab: "today", today: { hasRanch: false }, ranch: null })).toEqual(["today"]);
  });
});

describe("Today saying whether there's a ranch", () => {
  it("says so from a server with a ranch, to the screen only, on show_today and its refresh", async () => {
    const ranch = sampleRanch();
    for (const name of ["show_today", "refresh_today"]) {
      const result = await call(name, ranch);
      expect(result.structuredContent.hasRanch).toBe(true);
      expect(tabs({ tab: "today", today: result.structuredContent, ranch: null })).toEqual(EVERY);
      // The assistant hears today as it always has.
      expect(JSON.parse(result.content[0]!.text)).not.toHaveProperty("hasRanch");
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ household: "Juniper Hollow", events: expect.any(Array) });
    }
  });

  it("says nothing of a ranch from a server without one, like a household linked to a real Corral, so the rail stays Today alone", async () => {
    for (const name of ["show_today", "refresh_today"]) {
      const result = await call(name);
      expect(result.structuredContent).not.toHaveProperty("hasRanch");
      expect(tabs({ tab: "today", today: result.structuredContent, ranch: null })).toEqual(["today"]);
    }
  });
});
