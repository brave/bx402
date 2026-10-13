import { describe, expect, it } from "vitest";
import { PayerWindow } from "../src/payers.js";

/** One hour, the window an address counts as a recent payer for. */
const HOUR_MS = 3_600_000;

describe("payers", () => {
  it("the_same_payer_paying_again_is_still_one_payer", () => {
    const window = new PayerWindow();
    window.seen("x402", "0xabc", 0);
    window.seen("x402", "0xabc", 1_000);
    // The same address as the first, spelled the way a checksum spells it.
    window.seen("x402", "0xABC", 1_500);
    window.seen("x402", "0xdef", 2_000);

    expect(window.counts(3_000)).toEqual(new Map([["x402", 2]]));
  });

  it("each_rail_counts_its_own_payers", () => {
    const window = new PayerWindow();
    window.seen("x402", "0xabc", 0);
    window.seen("mpp", "0xabc", 0);

    expect(window.counts(0)).toEqual(
      new Map([
        ["x402", 1],
        ["mpp", 1],
      ]),
    );
  });

  it("a_payer_falls_out_of_the_window_and_paying_again_extends_it", () => {
    const window = new PayerWindow();
    window.seen("x402", "0xabc", 0);
    expect(window.counts(HOUR_MS + 1)).toEqual(new Map([["x402", 0]]));

    window.seen("x402", "0xabc", HOUR_MS);
    // Counted an hour after the second payment, not the first.
    expect(window.counts(HOUR_MS + 1)).toEqual(new Map([["x402", 1]]));
    expect(window.counts(2 * HOUR_MS + 1)).toEqual(new Map([["x402", 0]]));
  });

  it("a_payer_per_payment_cannot_grow_the_window_without_limit", () => {
    const window = new PayerWindow();
    for (let payer = 0; payer < 10_050; payer++) {
      window.seen("x402", `0x${payer}`, 0);
    }

    expect(window.counts(0)).toEqual(new Map([["x402", 10_000]]));
  });
});
