import { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/env.ts";
import { SampleHouseholdObject } from "../src/sample/durable.ts";

/**
 * A Durable Object's SQL storage on Node's own SQLite: enough of the API
 * (exec with bindings, and a cursor's toArray and one) for the sample
 * household's store, against a real database.
 */
export function fakeSql(db: DatabaseSync): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...(bindings as (string | number | null)[])) as Record<string, SqlStorageValue>[];
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0]!;
        },
      };
    },
  } as unknown as SqlStorage;
}

export interface FakeHouseholds {
  namespace: DurableObjectNamespace<SampleHouseholdObject>;
  /** Every name the Worker asked the namespace for, in order. */
  asked: string[];
  /** Each household's database, which outlives its object. */
  databases: Map<string, DatabaseSync>;
  /** Drops every live object, as an eviction or a deploy would, leaving their storage. */
  restart(): void;
}

/** A Durable Object namespace of sample households, each a real SampleHouseholdObject on its own SQLite database. */
export function fakeHouseholds(env: Env = {}): FakeHouseholds {
  const asked: string[] = [];
  const databases = new Map<string, DatabaseSync>();
  const objects = new Map<string, SampleHouseholdObject>();
  const namespace = {
    getByName(name: string) {
      asked.push(name);
      let object = objects.get(name);
      if (!object) {
        let db = databases.get(name);
        if (!db) databases.set(name, (db = new DatabaseSync(":memory:")));
        object = new SampleHouseholdObject({ storage: { sql: fakeSql(db) } } as unknown as DurableObjectState, env);
        objects.set(name, object);
      }
      return object;
    },
  } as unknown as DurableObjectNamespace<SampleHouseholdObject>;
  return { namespace, asked, databases, restart: () => objects.clear() };
}

/** A namespace that fails the test if anything asks it for a household. */
export function forbiddenHouseholds(): { namespace: DurableObjectNamespace<SampleHouseholdObject>; asked: string[] } {
  const asked: string[] = [];
  const namespace = {
    getByName(name: string) {
      asked.push(name);
      throw new Error(`Corral mode asked for the sample household "${name}"`);
    },
    idFromName(name: string) {
      asked.push(name);
      throw new Error(`Corral mode asked for the sample household "${name}"`);
    },
  } as unknown as DurableObjectNamespace<SampleHouseholdObject>;
  return { namespace, asked };
}
