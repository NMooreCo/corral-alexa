/**
 * Where a shared sample household is kept between requests: in a Durable
 * Object's SQLite storage when it's deployed, in memory otherwise.
 */

/** A sample household as it's kept. */
export interface KeptSample {
  /** The household's day, like "2026-10-17", in its own time zone. */
  day: string;
  /** Goes up by one with every change, every reset and every new day, and never goes back. */
  version: number;
  /** The household's state, as JSON (see freeze and thaw). */
  state: string;
}

export interface SampleStore {
  load(): KeptSample | null;
  save(kept: KeptSample): void;
}

/** Kept for as long as this isolate lives. */
export function memoryStore(): SampleStore {
  let kept: KeptSample | null = null;
  return {
    load: () => kept,
    save: (k) => void (kept = { ...k }),
  };
}

/**
 * Kept in a SQLite-backed Durable Object's own database: one row, since each
 * object is one household. The SQL API is synchronous, so a change and its
 * save happen together, before any other request to the object runs.
 */
export function sqlStore(sql: SqlStorage): SampleStore {
  sql.exec(`CREATE TABLE IF NOT EXISTS household (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    day TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL
  )`);
  return {
    load() {
      const [row] = sql.exec<{ day: string; version: number; state: string }>("SELECT day, version, state FROM household WHERE id = 1").toArray();
      return row ? { day: row.day, version: Number(row.version), state: row.state } : null;
    },
    save(k) {
      sql.exec(
        "INSERT INTO household (id, day, version, state) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET day = excluded.day, version = excluded.version, state = excluded.state",
        k.day,
        k.version,
        k.state,
      );
    },
  };
}
