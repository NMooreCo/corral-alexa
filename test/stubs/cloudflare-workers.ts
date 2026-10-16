/** Enough of the Workers runtime module for the OAuth provider to load in Node. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}
