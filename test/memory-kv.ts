/** An in-memory stand-in for a Workers KV namespace, with expiry and metadata, for tests in Node. */
export class MemoryKV {
  readonly #rows = new Map<string, { value: string; expires?: number; metadata?: unknown }>();

  #live(key: string) {
    const row = this.#rows.get(key);
    if (row?.expires && row.expires <= Date.now()) {
      this.#rows.delete(key);
      return undefined;
    }
    return row;
  }

  async get(key: string, opts?: "text" | "json" | { type?: "text" | "json" }): Promise<unknown> {
    const row = this.#live(key);
    if (!row) return null;
    const type = typeof opts === "string" ? opts : opts?.type;
    return type === "json" ? JSON.parse(row.value) : row.value;
  }

  async getWithMetadata(key: string, opts?: "text" | "json" | { type?: "text" | "json" }) {
    const row = this.#live(key);
    return { value: row ? await this.get(key, opts) : null, metadata: row?.metadata ?? null };
  }

  async put(key: string, value: string, opts: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {}): Promise<void> {
    const expires = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts.expiration ? opts.expiration * 1000 : undefined;
    this.#rows.set(key, { value, expires, metadata: opts.metadata });
  }

  async delete(key: string): Promise<void> {
    this.#rows.delete(key);
  }

  async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const names = [...this.#rows.keys()].filter((k) => this.#live(k) && k.startsWith(opts.prefix ?? "")).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? 1000;
    const page = names.slice(start, start + limit);
    const done = start + limit >= names.length;
    return {
      keys: page.map((name) => ({ name, metadata: this.#rows.get(name)?.metadata, ...(this.#rows.get(name)?.expires ? { expiration: Math.floor(this.#rows.get(name)!.expires! / 1000) } : {}) })),
      list_complete: done,
      ...(done ? {} : { cursor: String(start + limit) }),
    };
  }

  /** How many rows start with `prefix`, for tests. */
  count(prefix: string): number {
    return [...this.#rows.keys()].filter((k) => this.#live(k) && k.startsWith(prefix)).length;
  }
}
