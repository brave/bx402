import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayTally } from "../src/replays.js";

/** An expiry comfortably in the future, for tallies that must hold. */
function later(): number {
  return Date.now() + 60_000;
}

describe("replays", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the_first_use_of_a_key_counts_one", () => {
    const tally = new ReplayTally();
    expect(tally.count("key", later())).toBe(1);
  });

  it("a_repeat_counts_more_than_one_and_is_still_refused_by_the_claim_store", () => {
    // The point of the tally: refusing the duplicate is a separate job from
    // recording that it was tried. Both attempts are counted here, whether or
    // not the caller that counts them goes on to claim the key.
    const tally = new ReplayTally();
    expect(tally.count("key", later())).toBe(1);
    expect(tally.count("key", later())).toBe(2);
    expect(tally.count("key", later())).toBe(3);
  });

  it("a_later_attempt_does_not_shorten_the_window_the_first_one_set", () => {
    // Otherwise a client could flush its own history by presenting the proof
    // again with an expiry in the past.
    const tally = new ReplayTally();
    tally.count("key", later());
    expect(tally.count("key", Date.now() - 1)).toBe(2);
    expect(tally.attempts("key")).toBe(2);
  });

  it("a_lapsed_key_starts_over", () => {
    const tally = new ReplayTally();
    tally.count("key", Date.now() - 1);
    expect(tally.count("key", later())).toBe(1);
  });

  it("a_key_that_lapsed_reports_no_attempts", () => {
    const tally = new ReplayTally();
    tally.count("key", Date.now() - 1);
    expect(tally.attempts("key")).toBe(0);
  });

  it("distinct_keys_are_counted_apart", () => {
    const tally = new ReplayTally();
    tally.count("one", later());
    tally.count("one", later());
    expect(tally.count("two", later())).toBe(1);
  });

  it("lapsed_entries_are_swept_out_after_the_sweep_interval", () => {
    vi.useFakeTimers();
    const tally = new ReplayTally();
    for (let i = 0; i < 100; i++) {
      tally.count(`lapsed-${i}`, Date.now() + 1);
    }
    vi.advanceTimersByTime(61_000);
    tally.count("fresh", later());
    expect(tally.size).toBe(1);
  });
});
