import type { Temporal } from "temporal-polyfill";
import { ToolError } from "../household.ts";
import type { Supplier, SupplierLine, SupplierProduct, SupplierReceipt } from "../orders.ts";

/**
 * The sample household's store: Valley Feed & Propane, a made-up feed store
 * and propane dealer. It's a sample, so its orders go nowhere and nothing is
 * charged. It sells what the sample ranch runs low on, at about what those
 * cost in the fall of 2026, and delivers in one to three days. A real store
 * would plug in behind the same Supplier interface, the way a real
 * greenhouse controller does for the ranch's devices.
 */

const CATALOG: SupplierProduct[] = [
  { id: "propane", supply: "Propane", unit: "gallon", usualQuantity: 100, unitPriceCents: 289, deliveryDays: 2 },
  { id: "dog-food-40", supply: "Dog food", unit: "40 lb bag", usualQuantity: 1, unitPriceCents: 5499, deliveryDays: 1 },
  { id: "horse-feed-50", supply: "Horse feed", unit: "50 lb bag", usualQuantity: 4, unitPriceCents: 2499, deliveryDays: 2 },
  { id: "layer-pellets-50", supply: "Layer pellets", unit: "50 lb bag", usualQuantity: 2, unitPriceCents: 2149, deliveryDays: 2 },
  { id: "hay-bale", supply: "Hay", unit: "bale", usualQuantity: 20, unitPriceCents: 1450, deliveryDays: 3 },
];

export class SampleSupplier implements Supplier {
  readonly id = "sample.valley-feed";
  readonly name = "Valley Feed & Propane";
  readonly live = false;
  readonly #now: () => Temporal.Instant;
  readonly #timeZone: string;

  constructor(opts: { now: () => Temporal.Instant; timeZone: string }) {
    this.#now = opts.now;
    this.#timeZone = opts.timeZone;
  }

  async catalog(): Promise<SupplierProduct[]> {
    return CATALOG.map((p) => ({ ...p }));
  }

  /** Takes the order as a store would: it arrives once the slowest thing in it can, counted from today where the household is. */
  async placeOrder(lines: SupplierLine[]): Promise<SupplierReceipt> {
    if (!lines.length) throw new ToolError("An order needs something in it.");
    let totalCents = 0;
    let days = 0;
    for (const line of lines) {
      const product = CATALOG.find((p) => p.id === line.product);
      if (!product) throw new ToolError(`${this.name} doesn't sell "${line.product}".`);
      if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new ToolError("Each thing in an order needs a whole number of them, 1 or more.");
      totalCents += line.quantity * product.unitPriceCents;
      days = Math.max(days, product.deliveryDays);
    }
    const today = this.#now().toZonedDateTimeISO(this.#timeZone).toPlainDate();
    return { reference: `VFP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, deliveryDate: today.add({ days }).toString(), totalCents };
  }
}
