import fc from "fast-check";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import type { CorralApprovals } from "../src/approvals.ts";
import type { CorralSupply } from "../src/household.ts";
import { amountWords, lineWords, quote, type CorralOrder, type Supplier, type SupplierLine, type SupplierProduct, type SupplierReceipt } from "../src/orders.ts";
import { SampleHousehold } from "../src/sample/index.ts";
import { SharedSample } from "../src/sample/shared.ts";
import { memoryStore } from "../src/sample/store.ts";
import { SampleSupplier } from "../src/sample/supplier.ts";

// Friday, October 16, 2026, 10:30 AM in Denver.
const FRIDAY = Temporal.Instant.from("2026-10-16T16:30:00Z");
// Saturday, October 17, 2026, 10:30 AM in Denver.
const SATURDAY = Temporal.Instant.from("2026-10-17T16:30:00Z");

// The property check below tries the same generated orders every run, so a failure reproduces.
fc.configureGlobal({ seed: 20261016 });

function household(opts: { now?: () => Temporal.Instant; suppliers?: Supplier[] } = {}) {
  return new SampleHousehold({ now: opts.now ?? (() => FRIDAY), ...(opts.suppliers ? { suppliers: opts.suppliers } : {}) });
}

const supplies = async (h: SampleHousehold, who = "Nick") => (await h.as(who).call("supplies", {})) as CorralSupply[];
const supply = async (h: SampleHousehold, name: string) => (await supplies(h)).find((s) => s.name === name)!;
const orders = async (h: SampleHousehold, who = "Nick") => (await h.as(who).call("orders", {})) as CorralOrder[];

/** A store for tests: it sells what it's given, and keeps every order it takes. */
class TestStore implements Supplier {
  readonly live = true;
  readonly placed: SupplierLine[][] = [];
  constructor(
    readonly id: string,
    readonly name: string,
    readonly products: SupplierProduct[],
    readonly down = false,
  ) {}
  async catalog() {
    return this.products;
  }
  async placeOrder(lines: SupplierLine[]): Promise<SupplierReceipt> {
    if (this.down) throw new Error("connection refused");
    this.placed.push(lines);
    const totalCents = lines.reduce((sum, l) => sum + l.quantity * this.products.find((p) => p.id === l.product)!.unitPriceCents, 0);
    return { reference: `${this.id}-${this.placed.length}`, deliveryDate: "2026-10-20", totalCents };
  }
}

const product = (supply: string, more: Partial<SupplierProduct> = {}): SupplierProduct => ({ id: supply.toLowerCase().replace(/ /g, "-"), supply, unit: "bag", usualQuantity: 1, unitPriceCents: 1000, deliveryDays: 1, ...more });

describe("the sample store", () => {
  it("is a sample, selling each of the sample's supplies in whole cents", async () => {
    const h = household();
    const store = new SampleSupplier({ now: () => FRIDAY, timeZone: "America/Denver" });
    expect(store).toMatchObject({ name: "Valley Feed & Propane", live: false });
    const catalog = await store.catalog();
    expect(catalog.map((p) => p.supply).sort()).toEqual(h.state.supplies.map((s) => s.name).sort());
    for (const p of catalog) {
      expect(Number.isInteger(p.unitPriceCents) && p.unitPriceCents > 0).toBe(true);
      expect(p.deliveryDays).toBeGreaterThanOrEqual(1);
      expect(p.deliveryDays).toBeLessThanOrEqual(3);
    }
    expect(catalog.find((p) => p.supply === "Propane")).toMatchObject({ unit: "gallon", usualQuantity: 100, unitPriceCents: 289 });
    expect(catalog.find((p) => p.supply === "Dog food")).toMatchObject({ unit: "40 lb bag", usualQuantity: 1, unitPriceCents: 5499 });
  });

  it("delivers an order once the slowest thing in it can, counted from today where the household is", async () => {
    const store = new SampleSupplier({ now: () => FRIDAY, timeZone: "America/Denver" });
    const receipt = await store.placeOrder([
      { product: "propane", quantity: 100 },
      { product: "hay-bale", quantity: 20 },
    ]);
    expect(receipt).toEqual({ reference: expect.stringMatching(/^VFP-[0-9A-F]{8}$/), deliveryDate: "2026-10-19", totalCents: 57_900 });
    await expect(store.placeOrder([{ product: "caviar", quantity: 1 }])).rejects.toThrow('Valley Feed & Propane doesn\'t sell "caviar".');
  });
});

describe("a parent's order", () => {
  it("is placed now, with its total in cents and its delivery day, and shows as on order in supplies", async () => {
    const h = household();
    const res = await h.as("Nick").call("place_order", { items: [{ supply: "propane" }] });
    expect(res).toEqual({ status: "done", summary: "Ordered 100 gallons of propane from Valley Feed & Propane: $289.00, arriving Sun, Oct 18", order: expect.any(String), total: "$289.00", arrives: "Sun, Oct 18" });
    const nick = h.state.people.find((p) => p.shortName === "Nick")!;
    expect(h.state.orders).toEqual([
      expect.objectContaining({
        totalCents: 28_900,
        status: "placed",
        deliveryDate: "2026-10-18",
        by: nick.id,
        reference: expect.stringMatching(/^VFP-/),
        lines: [{ supply: "Propane", product: "propane", unit: "gallon", quantity: 100, unitPriceCents: 289 }],
      }),
    ]);
    // Still low until it comes, but it's taken care of.
    expect(await supply(h, "Propane")).toMatchObject({ low: true, onOrder: { order: (res as { order: string }).order, amount: "100 gallons", supplier: "Valley Feed & Propane", arrives: "Sun, Oct 18", arrivesOn: "2026-10-18" } });
    expect((await supply(h, "Propane")).onOrder?.waitingFor).toBeUndefined();
    expect(await orders(h)).toEqual([
      { id: (res as { order: string }).order, supplier: "Valley Feed & Propane", items: ["100 gallons of propane"], total: "$289.00", totalCents: 28_900, status: "placed", arrives: "Sun, Oct 18", by: "Nick", live: false },
    ]);
  });

  it("orders how many it's asked for, and supplies say each one's usual order, price and day", async () => {
    const h = household();
    expect((await supply(h, "Dog food")).reorder).toEqual({ supplier: "Valley Feed & Propane", amount: "a 40 lb bag", price: "$54.99", arrives: "Sat, Oct 17" });
    expect((await supply(h, "Propane")).reorder).toEqual({ supplier: "Valley Feed & Propane", amount: "100 gallons", price: "$289.00", arrives: "Sun, Oct 18" });
    expect(await h.as("Holly").call("place_order", { items: [{ supply: "dog food", quantity: 2 }] })).toMatchObject({ status: "done", summary: "Ordered 2 40 lb bags of dog food from Valley Feed & Propane: $109.98, arriving Sat, Oct 17" });
    // The same supply twice is one line.
    expect(await h.as("Holly").call("place_order", { items: [{ supply: "Horse feed", quantity: 1 }, { supply: "horse feed", quantity: 2 }] })).toMatchObject({ summary: "Ordered 3 50 lb bags of horse feed from Valley Feed & Propane: $74.97, arriving Sun, Oct 18" });
    expect(h.state.orders.map((o) => o.totalCents)).toEqual([10_998, 7497]);
  });

  it("over the household's limit waits for the other parent, who decides it, and never for the one who placed it", async () => {
    const h = household();
    const res = (await h.as("Nick").call("place_order", { items: [{ supply: "propane" }, { supply: "hay" }] })) as { requestId: string };
    expect(res).toEqual({
      status: "waiting_for_approval",
      summary: "Order 100 gallons of propane and 20 bales of hay from Valley Feed & Propane, $579.00",
      approvers: ["Holly"],
      requestId: expect.any(String),
      note: "It's $579.00, over Juniper Hollow's $300.00 limit for one order, so Holly decides.",
    });
    expect((await supply(h, "Hay")).onOrder).toMatchObject({ arrives: null, waitingFor: "Holly" });
    const mine = (await h.as("Nick").call("approvals", {})) as CorralApprovals;
    expect(mine.yoursWaiting).toEqual([{ id: res.requestId, asks: "Order 100 gallons of propane and 20 bales of hay from Valley Feed & Propane, $579.00", since: "Fri, Oct 16, 10:30 AM", decidedBy: "Holly" }]);
    expect(mine.toDecide.map((r) => r.id)).not.toContain(res.requestId);
    await expect(h.as("Nick").call("decide_approval", { request: res.requestId, decision: "approve" })).rejects.toThrow("They can't approve or decline their own request, which waits for Holly.");

    expect(await h.as("Holly").call("decide_approval", { request: res.requestId, decision: "approve" })).toEqual({
      status: "done",
      summary: "Approved Nick's request: Order 100 gallons of propane and 20 bales of hay from Valley Feed & Propane, $579.00. It arrives Mon, Oct 19.",
      order: expect.any(String),
      arrives: "Mon, Oct 19",
    });
    expect(await orders(h)).toEqual([expect.objectContaining({ status: "placed", totalCents: 57_900, arrives: "Mon, Oct 19", by: "Nick" })]);
  });

  it("follows the limit as data: at the limit is fine, a cent over waits, and no limit means none", async () => {
    const at = household();
    at.state.orderLimitCents = 28_900;
    expect(await at.as("Nick").call("place_order", { items: [{ supply: "propane" }] })).toMatchObject({ status: "done" });
    const over = household();
    over.state.orderLimitCents = 28_899;
    expect(await over.as("Nick").call("place_order", { items: [{ supply: "propane" }] })).toMatchObject({ status: "waiting_for_approval", approvers: ["Holly"] });
    const none = household();
    none.state.orderLimitCents = null;
    const everything = none.state.supplies.map((s) => ({ supply: s.name }));
    expect(await none.as("Nick").call("place_order", { items: everything })).toMatchObject({ status: "done", total: "$776.93" });
  });

  it("over the limit with no one else to approve it is refused, rather than left waiting for no one", async () => {
    const h = household();
    h.state.people.find((p) => p.shortName === "Holly")!.roles = ["Kid"];
    await expect(h.as("Nick").call("place_order", { items: [{ supply: "propane" }, { supply: "hay" }] })).rejects.toThrow(
      "It's $579.00, over Juniper Hollow's $300.00 limit for one order, and no one else here approves requests, so nothing was ordered.",
    );
    expect(h.state.orders).toEqual([]);
  });
});

describe("a kid's order", () => {
  it("goes to a parent, places nothing, and a parent's yes places it", async () => {
    const store = new TestStore("feed", "Valley Feed & Propane", [product("Dog food", { unit: "40 lb bag", unitPriceCents: 5499, id: "dog-food-40" })]);
    const h = household({ suppliers: [store] });
    const res = (await h.as("Eli").call("place_order", { items: [{ supply: "dog food" }] })) as { requestId: string };
    expect(res).toEqual({ status: "waiting_for_approval", summary: "Order a 40 lb bag of dog food from Valley Feed & Propane, $54.99", approvers: ["Nick", "Holly"], requestId: expect.any(String) });
    expect(store.placed).toEqual([]);
    expect((await supply(h, "Dog food")).onOrder).toEqual({ order: expect.any(String), amount: "a 40 lb bag", supplier: "Valley Feed & Propane", arrives: null, arrivesOn: null, waitingFor: "Nick or Holly" });
    expect(await orders(h, "Eli")).toEqual([expect.objectContaining({ status: "waiting_for_approval", by: "Eli", arrives: null, waitingFor: "Nick or Holly" })]);

    // It's on the approvals screen for a parent.
    const nick = (await h.as("Nick").call("approvals", {})) as CorralApprovals;
    expect(nick.toDecide).toContainEqual({ id: res.requestId, from: "Eli", asks: "Order a 40 lb bag of dog food from Valley Feed & Propane, $54.99", since: "Fri, Oct 16, 10:30 AM" });

    expect(await h.as("Nick").call("decide_approval", { request: res.requestId, decision: "approve" })).toMatchObject({
      status: "done",
      summary: "Approved Eli's request: Order a 40 lb bag of dog food from Valley Feed & Propane, $54.99. It arrives Tue, Oct 20.",
    });
    expect(store.placed).toEqual([[{ product: "dog-food-40", quantity: 1 }]]);
    expect(await orders(h, "Eli")).toEqual([expect.objectContaining({ status: "placed", by: "Eli", arrives: "Tue, Oct 20", live: true })]);
    expect(h.state.orders[0]).toMatchObject({ reference: "feed-1", deliveryDate: "2026-10-20" });
    expect(((await h.as("Eli").call("approvals", {})) as CorralApprovals).yoursWaiting).toEqual([]);
  });

  it("comes off the orders when a parent declines it", async () => {
    const h = household();
    const { requestId } = (await h.as("Jak").call("place_order", { items: [{ supply: "hay" }] })) as { requestId: string };
    expect(await h.as("Holly").call("decide_approval", { request: requestId, decision: "decline" })).toEqual({ status: "done", summary: "Declined Jak's request: Order 20 bales of hay from Valley Feed & Propane, $290.00" });
    expect(await orders(h)).toEqual([]);
    expect((await supply(h, "Hay")).onOrder).toBeUndefined();
  });

  it("waits for a parent from the farm hand and the kitchen screen too, and the household's data can let a kid order", async () => {
    const h = household();
    expect(await h.as("Jon").call("place_order", { items: [{ supply: "hay" }] })).toMatchObject({ status: "waiting_for_approval", approvers: ["Nick", "Holly"] });
    expect(await h.call("place_order", { items: [{ supply: "hay" }] })).toMatchObject({ status: "waiting_for_approval", approvers: ["Nick", "Holly"] });
    expect((await orders(h)).map((o) => o.by)).toEqual(["Jon", "The kitchen screen"]);
    // Changing the data changes the rule, with no code naming anyone.
    h.state.roles.find((r) => r.name === "Kid")!.orders = true;
    expect(await h.as("Eli").call("place_order", { items: [{ supply: "dog food" }] })).toMatchObject({ status: "done" });
  });

  it("is placed once when both parents say yes at the same moment", async () => {
    let answer = () => {};
    // A store that takes its time, as a real one over the network would.
    const slow = new (class extends TestStore {
      override async placeOrder(lines: SupplierLine[]) {
        await new Promise<void>((resolve) => (answer = resolve));
        return super.placeOrder(lines);
      }
    })("feed", "Valley Feed & Propane", [product("Dog food")]);
    const h = household({ suppliers: [slow] });
    const { requestId } = (await h.as("Eli").call("place_order", { items: [{ supply: "dog food" }] })) as { requestId: string };
    const nick = h.as("Nick").call("decide_approval", { request: requestId, decision: "approve" });
    await expect(h.as("Holly").call("decide_approval", { request: requestId, decision: "approve" })).rejects.toThrow("That request is being decided right now.");
    answer();
    expect(await nick).toMatchObject({ status: "done" });
    expect(slow.placed).toHaveLength(1);
    await expect(h.as("Holly").call("decide_approval", { request: requestId, decision: "approve" })).rejects.toThrow("That request was already approved by Nick.");
  });

  it("stays waiting when the store won't take it at a parent's yes", async () => {
    const store = new TestStore("feed", "Valley Feed & Propane", [product("Dog food")], true);
    const h = household({ suppliers: [store] });
    const { requestId } = (await h.as("Eli").call("place_order", { items: [{ supply: "dog food" }] })) as { requestId: string };
    await expect(h.as("Holly").call("decide_approval", { request: requestId, decision: "approve" })).rejects.toThrow("Valley Feed & Propane didn't take the order just now, so nothing was ordered. Try again in a moment.");
    expect(((await h.as("Holly").call("approvals", {})) as CorralApprovals).toDecide.map((r) => r.id)).toContain(requestId);
    expect(await orders(h)).toEqual([expect.objectContaining({ status: "waiting_for_approval" })]);
  });
});

describe("what can't be ordered", () => {
  it("is refused in words, and nothing is ordered", async () => {
    const h = household();
    h.state.supplies.push({ id: "fly-spray", name: "Fly spray", quantity: 1, unit: "bottle", perDay: 0.1, lowAt: 1, onList: null });
    const refusals: [Record<string, unknown>, string][] = [
      [{ items: [{ supply: "caviar" }] }, 'There\'s no supply called "caviar" here to order. Supplies: Horse feed, Hay, Dog food, Layer pellets, Propane, Fly spray.'],
      [{ items: [{ supply: "fly spray" }] }, "Valley Feed & Propane doesn't sell fly spray. It sells propane, dog food, horse feed, layer pellets and hay."],
      [{ items: [{ supply: "hay" }], supplier: "Tractor World" }, 'There\'s no store called "Tractor World" to order from. Stores: Valley Feed & Propane.'],
      [{ items: [{ supply: "dog food", quantity: 0 }] }, "Say how many 40 lb bags of dog food as a whole number, 1 or more."],
      [{ items: [{ supply: "dog food", quantity: 2.5 }] }, "Say how many 40 lb bags of dog food as a whole number, 1 or more."],
      [{ items: [] }, "Say what to order: one to 12 of the supplies from the supplies tool."],
    ];
    for (const [args, said] of refusals) await expect(h.as("Nick").call("place_order", args)).rejects.toThrow(said);
    expect(h.state.orders).toEqual([]);
    expect(h.state.requests).toHaveLength(1);
  });

  it("is refused when the store won't take it", async () => {
    const h = household({ suppliers: [new TestStore("feed", "Valley Feed & Propane", [product("Dog food")], true)] });
    await expect(h.as("Nick").call("place_order", { items: [{ supply: "dog food" }] })).rejects.toThrow("Valley Feed & Propane didn't take the order just now, so nothing was ordered. Try again in a moment.");
    expect(h.state.orders).toEqual([]);
  });
});

describe("choosing a store", () => {
  it("takes the one named, or else the first that sells everything, and says when no one store does", async () => {
    const corner = new TestStore("corner", "Corner Feed", [product("Propane", { unit: "gallon" })]);
    const big = new TestStore("big", "Big Ranch Supply", [product("Propane", { unit: "gallon" }), product("Hay", { unit: "bale" })]);
    const h = household({ suppliers: [corner, big] });
    await h.as("Nick").call("place_order", { items: [{ supply: "propane" }] });
    await h.as("Nick").call("place_order", { items: [{ supply: "hay" }] });
    await h.as("Nick").call("place_order", { items: [{ supply: "propane" }], supplier: "big ranch" });
    await h.as("Nick").call("place_order", { items: [{ supply: "propane" }, { supply: "hay" }] });
    expect(h.state.orders.map((o) => o.supplier.name)).toEqual(["Corner Feed", "Big Ranch Supply", "Big Ranch Supply", "Big Ranch Supply"]);
    // The first store that sells it says how it's usually ordered.
    expect((await supply(h, "Propane")).reorder?.supplier).toBe("Corner Feed");
    expect((await supply(h, "Dog food")).reorder).toBeUndefined();

    const split = household({ suppliers: [corner, new TestStore("bales", "Bale Barn", [product("Hay", { unit: "bale" })])] });
    await expect(split.as("Nick").call("place_order", { items: [{ supply: "propane" }, { supply: "hay" }] })).rejects.toThrow("No one store sells all of those, so order them separately: Corner Feed sells propane; Bale Barn sells hay.");
    await expect(split.as("Nick").call("place_order", { items: [{ supply: "dog food" }] })).rejects.toThrow("None of the stores here sells dog food. Put it on a list instead.");
    await expect(household({ suppliers: [] }).as("Nick").call("place_order", { items: [{ supply: "hay" }] })).rejects.toThrow("There's no store to order from here. Put it on a list instead.");
  });

  it("always totals whole cents: each line's quantity times its price (property)", async () => {
    // Any store's catalog, and any order from it from one bag to a truckload, the same supply asked for twice included.
    const order = fc
      .uniqueArray(
        fc.record({ supply: fc.stringMatching(/^[A-Z][a-z]{2,9}$/), unitPriceCents: fc.integer({ min: 1, max: 500_000 }), usualQuantity: fc.integer({ min: 1, max: 200 }), deliveryDays: fc.integer({ min: 0, max: 14 }) }),
        { minLength: 1, maxLength: 6, selector: (p) => p.supply.toLowerCase() },
      )
      .chain((sold) =>
        fc.record({
          sold: fc.constant(sold.map((p) => product(p.supply, p))),
          items: fc.array(fc.record({ supply: fc.constantFrom(...sold.map((p) => p.supply)), quantity: fc.option(fc.integer({ min: 1, max: 500 }), { nil: undefined }) }), { minLength: 1, maxLength: 8 }),
        }),
      );
    const today = Temporal.PlainDate.from("2026-10-16");
    await fc.assert(
      fc.asyncProperty(order, async ({ sold, items }) => {
        const q = await quote([new TestStore("feed", "Valley Feed & Propane", sold)], items, { today });
        const sells = (supply: string) => sold.find((p) => p.supply === supply)!;
        expect(Number.isSafeInteger(q.totalCents)).toBe(true);
        expect(q.totalCents).toBe(items.reduce((sum, it) => sum + (it.quantity ?? sells(it.supply).usualQuantity) * sells(it.supply).unitPriceCents, 0));
        expect(q.totalCents).toBe(q.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0));
        // The same supply twice is one line.
        expect(new Set(q.lines.map((l) => l.product)).size).toBe(q.lines.length);
        expect(q.deliveryDate).toBe(today.add({ days: Math.max(...items.map((it) => sells(it.supply).deliveryDays)) }).toString());
      }),
    );
  });
});

describe("an order over time", () => {
  it("is delivered on its delivery day, and its supply is no longer on order", async () => {
    let now = FRIDAY;
    const h = household({ now: () => now });
    await h.as("Nick").call("place_order", { items: [{ supply: "dog food" }] });
    expect((await orders(h))[0]?.status).toBe("placed");
    now = SATURDAY;
    expect(await orders(h)).toEqual([expect.objectContaining({ status: "delivered", arrives: "Sat, Oct 17" })]);
    expect((await supply(h, "Dog food")).onOrder).toBeUndefined();
  });

  it("is kept with the household, through a restart", async () => {
    const store = memoryStore();
    const first = new SharedSample(store, { now: () => FRIDAY });
    const before = await first.version();
    await first.as("Nick").call("place_order", { items: [{ supply: "propane" }] });
    await first.as("Eli").call("place_order", { items: [{ supply: "dog food" }] });
    expect(await first.version()).toBe(before + 2);
    const second = new SharedSample(store, { now: () => FRIDAY });
    expect(await second.as("Nick").call("orders", {})).toEqual(await first.as("Nick").call("orders", {}));
    expect(await second.as("Nick").call("supplies", {})).toEqual(await first.as("Nick").call("supplies", {}));
    expect(((await second.as("Holly").call("approvals", {})) as CorralApprovals).toDecide.map((r) => r.from)).toContain("Eli");
  });
});

describe("orders in words", () => {
  it("says amounts the way people do", () => {
    expect(amountWords(1, "gallon")).toBe("a gallon");
    expect(amountWords(1, "8 lb bag")).toBe("an 8 lb bag");
    expect(amountWords(1, "11 lb bag")).toBe("an 11 lb bag");
    expect(amountWords(1, "110 lb bag")).toBe("a 110 lb bag");
    expect(amountWords(100, "gallon")).toBe("100 gallons");
    expect(amountWords(2, "box")).toBe("2 boxes");
    expect(amountWords(3, "lb")).toBe("3 lb");
    expect(lineWords({ quantity: 2, unit: "50 lb bag", supply: "Horse feed" })).toBe("2 50 lb bags of horse feed");
    expect(lineWords({ quantity: 1, unit: "tank", supply: "LP gas" })).toBe("a tank of LP gas");
  });
});
