/**
 * Attempt tallies over payment replay keys.
 *
 * `ClaimStore` decides *whether* a second use of one payment gets through.
 * This records *that it happened*. A refused duplicate is invisible today: the
 * caller is answered with the same generic rejection as any other refusal, and
 * nothing counts the attempt, so an operator cannot tell a client retrying once
 * from a client presenting the same proof a hundred times.
 *
 * Prevention and record are different jobs and only the first one is done by
 * refusing the request. The tally is what makes the difference between "we stop
 * replays" and "we can say how many there were", which is the part that survives
 * a restart of the process and can be handed to someone else.
 *
 * The tally is process-local and bounded the same way claims are: every entry
 * expires, so the map stays bounded by the paid request rate times the tally
 * window. It is not a substitute for a signed receipt that leaves the process;
 * it is the cheapest thing that turns an invisible refusal into a number.
 */

/** How often lapsed entries are swept out, in milliseconds. */
const SWEEP_INTERVAL_MS = 60_000;

export class ReplayTally {
  /** Each counted key mapped to how many times it has been seen, and until when. */
  private readonly seen = new Map<string, { attempts: number; expires: number }>();

  /** When the next sweep is due, so the map is walked at most once per interval. */
  private sweepDue = 0;

  /**
   * Record one attempt to use `key`, lapsing at `expires`, an epoch
   * millisecond. Returns the number of attempts seen for this key including
   * this one, so `1` is the first use and anything above it is a repeat.
   *
   * Called before the claim is taken rather than after, so a repeat that is
   * about to be refused is still counted. The check and the write run with no
   * await between them, so on Node's single event loop two callers can never
   * read the same count.
   */
  count(key: string, expires: number): number {
    const now = Date.now();
    this.sweep(now);
    const current = this.seen.get(key);
    if (current === undefined || current.expires <= now) {
      this.seen.set(key, { attempts: 1, expires });
      return 1;
    }
    current.attempts += 1;
    // A later attempt cannot shorten an earlier one's window: the first use
    // decides how long the key is remembered, so a client cannot flush its own
    // history by presenting the proof again.
    return current.attempts;
  }

  /** How many attempts have been seen for `key`, `0` when it has lapsed. */
  attempts(key: string): number {
    const now = Date.now();
    const current = this.seen.get(key);
    return current === undefined || current.expires <= now ? 0 : current.attempts;
  }

  /** The number of keys being tallied, for tests that watch the map stay bounded. */
  get size(): number {
    return this.seen.size;
  }

  /**
   * Drop lapsed entries, at most once per interval so the walk stays off the
   * per-request path. Between sweeps the expiry check in `count` treats a
   * lapsed entry as absent.
   */
  private sweep(now: number): void {
    if (now < this.sweepDue) {
      return;
    }
    this.sweepDue = now + SWEEP_INTERVAL_MS;
    for (const [key, { expires }] of this.seen) {
      if (expires <= now) {
        this.seen.delete(key);
      }
    }
  }
}
