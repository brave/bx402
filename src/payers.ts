/**
 * In-memory window over the addresses that have paid recently.
 *
 * Only the number of distinct addresses ever leaves this module, so no address
 * reaches a metric label, where it would both grow the series without bound and
 * be kept for as long as the metrics are. Entries expire and a cap bounds the
 * map, so a caller paying from a fresh address every time cannot grow it.
 */

/** How long one address counts as having paid recently, in milliseconds. */
const WINDOW_MS = 3_600_000;

/**
 * The most addresses held for one rail. A rail with more distinct payers than
 * this inside one window reports the cap instead of the true number: this
 * answers whether the traffic is one payer or many, and past the cap the answer
 * is many either way.
 */
const MAX_PAYERS = 10_000;

export class PayerWindow {
  /** Each rail's payers mapped to when they stop counting as recent. */
  private readonly payers = new Map<string, Map<string, number>>();

  /**
   * Record that `payer` paid on `rail` at `now`, an epoch millisecond. A payer
   * already held has its window extended, so the count follows who is paying
   * now rather than who paid first.
   */
  seen(rail: string, payer: string, now = Date.now()): void {
    // Lowercased, because the rails spell an address the way their own payload
    // does and the same payer in two spellings is still one payer.
    const address = payer.toLowerCase();
    const recent = this.payers.get(rail) ?? new Map<string, number>();
    this.payers.set(rail, recent);
    if (recent.size >= MAX_PAYERS && !recent.has(address)) {
      return;
    }
    recent.set(address, now + WINDOW_MS);
  }

  /**
   * How many distinct payers each rail has seen inside the window, dropping
   * those that have fallen out of it.
   *
   * The walk happens here rather than on the paying path, because this is read
   * once per scrape and written once per payment.
   */
  counts(now = Date.now()): Map<string, number> {
    const counted = new Map<string, number>();
    for (const [rail, recent] of this.payers) {
      for (const [payer, expires] of recent) {
        if (expires <= now) {
          recent.delete(payer);
        }
      }
      counted.set(rail, recent.size);
    }
    return counted;
  }
}
