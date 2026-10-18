import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";

const CTX = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const env: Env = { BACKEND: "sample", MODEL_MOCK: "true" };
const ask = async (text: string) =>
  (await worker.fetch(new Request("https://bridge.example/echo/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: text }], tools: [] }) }), env, CTX)).json() as Promise<{
    content: { type: string; name?: string; input?: unknown }[];
  }>;

describe("the simulator's practice model and the ranch", () => {
  it("runs a device for as long as it's asked", async () => {
    expect((await ask("Run the greenhouse misters for 30 seconds.")).content[0]).toMatchObject({ type: "tool_use", name: "set_device", input: { device: "greenhouse misters", state: "on", seconds: 30 } });
    expect((await ask("Turn on the drip line for 5 minutes")).content[0]).toMatchObject({ name: "set_device", input: { device: "drip line", minutes: 5 } });
  });

  it("shows the briefing for good morning, and the ranch for the animals", async () => {
    expect((await ask("Good morning")).content[0]).toMatchObject({ name: "show_briefing" });
    expect((await ask("Are any animals outside the fence?")).content[0]).toMatchObject({ name: "show_ranch" });
  });

  it("offers the ranch's requests on the simulator's page", async () => {
    const page = await (await worker.fetch(new Request("https://bridge.example/echo"), { BACKEND: "sample" }, CTX)).text();
    for (const s of ["Run the greenhouse misters for 30 seconds.", "Get the place ready.", "Good morning."]) expect(page).toContain(s);
  });
});
