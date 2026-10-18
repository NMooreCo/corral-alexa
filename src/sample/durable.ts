import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { serveMcp } from "../http.ts";
import { SharedSample, type SampleStatus } from "./shared.ts";
import { sqlStore } from "./store.ts";

/**
 * One sample household as a Durable Object (sample mode only). The Worker
 * sends every /mcp request for a household here, so two Echo Shows, or
 * Alexa+ and the simulator, see the same chore checked off, and the
 * object's SQLite storage keeps the household through restarts and deploys.
 * MCP is still served statelessly, one request at a time, from inside the
 * object.
 */
export class SampleHouseholdObject extends DurableObject<Env> {
  readonly #household: SharedSample;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Making the table is synchronous, so it's done before any request reaches the object.
    this.#household = new SharedSample(sqlStore(ctx.storage.sql));
  }

  /** An MCP request (either protocol era), answered from this household. */
  fetch(request: Request): Promise<Response> {
    return serveMcp(request, this.#household);
  }

  async status(): Promise<SampleStatus> {
    return this.#household.status();
  }

  /** Starts the household over, for a fresh demo take. */
  async reset(): Promise<SampleStatus> {
    return this.#household.reset();
  }
}
