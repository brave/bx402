import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryClaimStore } from "../../src/claims/memory.js";
import type { ClaimToken } from "../../src/claims/store.js";

/** An expiry comfortably in the future, for claims that must hold. */
function later(): number {
  return Date.now() + 60_000;
}

/** Claim `key`, asserting the store handed the claim out. */
async function claim(store: MemoryClaimStore, key: string, expires: number): Promise<ClaimToken> {
  const token = await store.tryClaim(key, expires);
  if (token === undefined) {
    throw new Error(`${key} is already claimed`);
  }
  return token;
}

describe("claims", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a_key_claims_once_and_a_second_claim_is_refused", async () => {
    const store = new MemoryClaimStore();
    await claim(store, "key", later());
    expect(await store.tryClaim("key", later())).toBeUndefined();
  });

  it("a_released_key_can_be_claimed_again", async () => {
    const store = new MemoryClaimStore();
    const token = await claim(store, "key", later());
    await store.release("key", token);
    await claim(store, "key", later());
  });

  it("a_lapsed_claim_can_be_claimed_again", async () => {
    const store = new MemoryClaimStore();
    await claim(store, "key", Date.now() - 1);
    await claim(store, "key", later());
  });

  it("a_stale_token_does_not_release_the_current_claim", async () => {
    // The first claim lapses and a second caller claims the key. When the
    // first caller then releases, the second claim must survive, or a third
    // caller could run concurrently with the second.
    const store = new MemoryClaimStore();
    const stale = await claim(store, "key", Date.now() - 1);
    await claim(store, "key", later());
    await store.release("key", stale);
    expect(await store.tryClaim("key", later())).toBeUndefined();
  });

  it("lapsed_entries_are_swept_out_after_the_sweep_interval", async () => {
    vi.useFakeTimers();
    const store = new MemoryClaimStore();
    for (let i = 0; i < 100; i++) {
      await claim(store, `lapsed-${i}`, Date.now() + 1);
    }
    // The sweep runs at most once per interval, so the lapsed entries linger
    // until the interval passes and the next claim walks the map.
    vi.advanceTimersByTime(61_000);
    await claim(store, "fresh", later());
    expect(store.size).toBe(1);
  });

  it("a_dropped_key_can_be_claimed_again_whoever_held_it", async () => {
    const store = new MemoryClaimStore();
    await claim(store, "key", later());
    await store.drop("key");
    await claim(store, "key", later());
  });

  it("distinct_keys_do_not_contend", async () => {
    const store = new MemoryClaimStore();
    await claim(store, "one", later());
    await claim(store, "two", later());
  });
});
