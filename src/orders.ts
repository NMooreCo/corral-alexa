import type { Temporal } from "temporal-polyfill";
import { ToolError } from "./household.ts";

/**
 * Ordering supplies from a store. A supplier is a connector, the way a
 * device source is for the ranch: a catalog that says which of the
 * household's supplies it sells, in what unit, how many at a time, for how
 * much and how soon, and a way to place an order. A sample store and a real
 * one look the same from here. What's sold and what it costs is the store's
 * data; nothing in this file asks which supply or store it's looking at.
 */

/** One thing a store sells, mapped to the household supply it restocks. */
export interface SupplierProduct {
  /** The store's own id for it, which an order names. */
  id: string;
  /** The household supply it restocks, by the household's name for it, like "Dog food". */
  supply: string;
  /** What one of it is, as people say it: "gallon", "40 lb bag", "bale". */
  unit: string;
  /** How many an order usually has, like 100 gallons or one bag. */
  usualQuantity: number;
  /** The price of one, in cents. */
  unitPriceCents: number;
  /** How many days after it's ordered it arrives. */
  deliveryDays: number;
}

/** A product and how many of it, as an order asks a store for it. */
export interface SupplierLine {
  product: string;
  quantity: number;
}

/** What a store answers when it takes an order. */
export interface SupplierReceipt {
  /** The store's own reference for the order. */
  reference: string;
  /** The day it arrives, like "2026-10-20". */
  deliveryDate: string;
  /** What the store charged, in cents. */
  totalCents: number;
}

/** Where a household orders supplies from: a sample store now, a real one later. */
export interface Supplier {
  /** Stable, like "sample.valley-feed". */
  readonly id: string;
  readonly name: string;
  /** True for a real store taking real orders; false for a sample, whose orders go nowhere. */
  readonly live: boolean;
  /** Everything it sells. */
  catalog(): Promise<SupplierProduct[]>;
  /** Places an order and answers when it arrives. Throws ToolError with a sentence for people when it can't. */
  placeOrder(lines: SupplierLine[]): Promise<SupplierReceipt>;
}

/** One line of an order as the household keeps it. */
export interface OrderLine {
  /** The household's name for the supply. */
  supply: string;
  /** The store's id for the product. */
  product: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
}

/** An order worked out against a store's catalog, not placed yet. */
export interface Quote {
  supplier: Supplier;
  lines: OrderLine[];
  totalCents: number;
  /** When it would arrive if it were ordered today, like "2026-10-20". */
  deliveryDate: string;
}

// ---------- What the tools say about orders ----------

/** An order as the orders tool says it. */
export interface CorralOrder {
  id: string;
  supplier: string;
  /** Each line in words: "100 gallons of propane". */
  items: string[];
  /** "$289.00". */
  total: string;
  totalCents: number;
  /** Delivered once its delivery day comes. */
  status: "waiting_for_approval" | "placed" | "delivered";
  /** The day it arrives, like "Tue, Oct 20"; null while it waits for a yes. */
  arrives: string | null;
  /** Who placed it, like "Nick", or "The kitchen screen". */
  by: string;
  /** Who can say yes to it, like "Nick or Holly", while it waits. */
  waitingFor?: string;
  /** False when the store is a sample, so nothing was really ordered. */
  live: boolean;
}

/** An order for a supply that hasn't come yet, as the supplies tool says it. */
export interface CorralSupplyOrder {
  /** The order's id from the orders tool. */
  order: string;
  /** How much is coming, in the store's units: "100 gallons". */
  amount: string;
  supplier: string;
  /** The day it arrives, like "Tue, Oct 20"; null while it waits for a yes. */
  arrives: string | null;
  /** The same day as a date, like "2026-10-20", for screens. */
  arrivesOn: string | null;
  /** Who can say yes to it, like "Nick or Holly", while it waits. */
  waitingFor?: string;
}

/** How a store sells a supply: its usual order, what that costs, and when it would come. */
export interface CorralReorder {
  supplier: string;
  /** "100 gallons". */
  amount: string;
  /** "$289.00". */
  price: string;
  /** If it were ordered now, like "Tue, Oct 20". */
  arrives: string;
}

// ---------- Working out an order ----------

/** "Dog food" and "dog food" are the same supply. */
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A store by its id or however someone says its name. */
function storeNamed(suppliers: Supplier[], said: string): Supplier {
  const s = said.trim().toLowerCase();
  const found =
    suppliers.find((x) => x.id === said || x.name.toLowerCase() === s) ?? suppliers.find((x) => s && (x.name.toLowerCase().includes(s) || s.includes(x.name.toLowerCase())));
  if (!found) throw new ToolError(`There's no store called "${said}" to order from. Stores: ${suppliers.map((x) => x.name).join(", ")}.`);
  return found;
}

async function catalogOf(supplier: Supplier): Promise<SupplierProduct[]> {
  try {
    return await supplier.catalog();
  } catch {
    throw new ToolError(`${supplier.name} isn't answering just now, so nothing was ordered. Try again in a moment.`);
  }
}

/**
 * Works out an order for these supplies (the household's names for them):
 * which store sells them all (the one named, or else the first that does),
 * how many of each (its usual order when none is said), what it costs and
 * when it would come. Places nothing. Refuses, in words for people, a supply
 * no store sells, a store that isn't there and an amount that isn't one.
 */
export async function quote(suppliers: Supplier[], items: { supply: string; quantity?: unknown }[], opts: { supplier?: unknown; today: Temporal.PlainDate }): Promise<Quote> {
  if (!suppliers.length) throw new ToolError("There's no store to order from here. Put it on a list instead.");
  if (!items.length) throw new ToolError("Say what to order.");
  const named = typeof opts.supplier === "string" && opts.supplier.trim() ? storeNamed(suppliers, opts.supplier) : null;
  const stores = named ? [named] : suppliers;
  const catalogs = await Promise.all(stores.map(async (s) => ({ supplier: s, products: await catalogOf(s) })));
  const sells = (c: (typeof catalogs)[number], supply: string) => c.products.find((p) => same(p.supply, supply));

  // One store for the whole order.
  const store = catalogs.find((c) => items.every((it) => sells(c, it.supply)));
  if (!store) {
    const nowhere = items.find((it) => !catalogs.some((c) => sells(c, it.supply)));
    if (nowhere) {
      const one = catalogs.length === 1 ? catalogs[0]! : null;
      throw new ToolError(
        one
          ? `${one.supplier.name} doesn't sell ${lowerFirst(nowhere.supply)}. It sells ${and(one.products.map((p) => lowerFirst(p.supply)))}.`
          : `None of the stores here sells ${lowerFirst(nowhere.supply)}. Put it on a list instead.`,
      );
    }
    const where = catalogs.map((c) => ({ c, here: items.filter((it) => sells(c, it.supply)) })).filter((x) => x.here.length);
    throw new ToolError(`No one store sells all of those, so order them separately: ${where.map(({ c, here }) => `${c.supplier.name} sells ${and(here.map((it) => lowerFirst(it.supply)))}`).join("; ")}.`);
  }

  // The same supply twice is one line.
  const lines: OrderLine[] = [];
  for (const it of items) {
    const product = sells(store, it.supply)!;
    const quantity = amountOf(it.quantity, product);
    const there = lines.find((l) => l.product === product.id);
    if (there) there.quantity += quantity;
    else lines.push({ supply: it.supply, product: product.id, unit: product.unit, quantity, unitPriceCents: product.unitPriceCents });
  }
  const days = Math.max(...lines.map((l) => sells(store, l.supply)!.deliveryDays));
  return {
    supplier: store.supplier,
    lines,
    totalCents: lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0),
    deliveryDate: opts.today.add({ days }).toString(),
  };
}

/** The most of one supply an order takes, so a slip ("a million bags") can't run a total past what a household keeps. */
const MAX_QUANTITY = 10_000;

/** How many to order: the number said, a whole one from 1 to MAX_QUANTITY, or the usual order when none is. */
function amountOf(said: unknown, product: SupplierProduct): number {
  if (said === undefined || said === null || said === "") return product.usualQuantity;
  const n = Number(said);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) {
    throw new ToolError(`Say how many ${plural(product.unit)} of ${lowerFirst(product.supply)} as a whole number from 1 to ${MAX_QUANTITY.toLocaleString("en-US")}.`);
  }
  return n;
}

// ---------- In words ----------

/** "gallons", "40 lb bags", "boxes"; a short unit like "lb" stays as it is. */
function plural(unit: string): string {
  return unit.replace(/(\S+)$/, (w) => (w.length <= 2 ? w : /(s|x|z|ch|sh)$/.test(w) ? `${w}es` : `${w}s`));
}

/** "a gallon", "an 8 lb bag", "100 gallons", "2 50 lb bags". */
export function amountWords(quantity: number, unit: string): string {
  if (quantity === 1) return `${/^(?:[aeio]|8|11(?!\d)|18(?!\d))/i.test(unit) ? "an" : "a"} ${unit}`;
  return `${quantity} ${plural(unit)}`;
}

/** "100 gallons of propane", "a 40 lb bag of dog food". */
export function lineWords(line: { quantity: number; unit: string; supply: string }): string {
  return `${amountWords(line.quantity, line.unit)} of ${lowerFirst(line.supply)}`;
}

/** "propane", "propane and hay", "propane, hay and dog food". */
export function and(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "Dog food" as it reads mid-sentence; a name that starts with capitals, like "LP gas", keeps them. */
function lowerFirst(name: string): string {
  return /^[A-Z][A-Z]/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1);
}
