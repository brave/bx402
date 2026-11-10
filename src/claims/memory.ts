import { randomUUID } from "node:crypto";
import type { ClaimStore, ClaimToken } from "./store.js";

/** How often lapsed entries are swept out, in milliseconds. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Claims held in this process. Two pods each keep their own, so this store
 * only suits a single process: local runs, tests, and deployments without a
 * shared table.
 */
export class MemoryClaimStore implements ClaimStore {
  /** Each claimed key mapped to when its claim lapses and who holds it. */
  private readonly claims = new Map<string, { expires: number; token: ClaimToken }>();

  /** When the next sweep is due, so the map is walked at most once per interval. */
  private sweepDue = 0;

  /**
   * The check and the write run with no await between them, so on Node's
   * single event loop two callers can never both claim a key.
   */
  async tryClaim(key: string, expires: number): Promise<ClaimToken | undefined> {
    const now = Date.now();
    this.sweep(now);
    const current = this.claims.get(key);
    if (current !== undefined && current.expires > now) {
      return undefined;
    }
    const token = randomUUID();
    this.claims.set(key, { expires, token });
    return token;
  }

  async release(key: string, token: ClaimToken): Promise<void> {
    if (this.claims.get(key)?.token === token) {
      this.claims.delete(key);
    }
  }

  /** The number of claims held, for tests that watch the map stay bounded. */
  get size(): number {
    return this.claims.size;
  }

  /**
   * Drop lapsed entries, at most once per interval so the walk stays off the
   * per-request path. Between sweeps the expiry check in `tryClaim` treats a
   * lapsed entry as absent.
   */
  private sweep(now: number): void {
    if (now < this.sweepDue) {
      return;
    }
    this.sweepDue = now + SWEEP_INTERVAL_MS;
    for (const [key, { expires }] of this.claims) {
      if (expires <= now) {
        this.claims.delete(key);
      }
    }
  }
}
