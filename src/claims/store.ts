/**
 * Claims over payment replay keys.
 *
 * A claim records the first use of a key until it expires, so concurrent
 * requests carrying the same payment can be told apart from the first one.
 * Every claim expires, so a store holds at most the paid request rate times
 * the claim window.
 */

/** Proof of holding a claim. Only the holder can release its key. */
export type ClaimToken = string;

/**
 * The store could not say whether a key is claimed: a timeout, an access
 * denial, or any other failure to reach it. The payment must be refused, since
 * an unanswered claim never proves first use. The underlying error is kept as
 * the cause for logs and is never shown to clients.
 */
export class ClaimStoreError extends Error {
  constructor(cause: unknown) {
    super("replay claim store unavailable", { cause });
    this.name = "ClaimStoreError";
  }
}

/** Where claims are recorded, shared by every request a store is handed to. */
export interface ClaimStore {
  /**
   * Record the first use of `key` until `expires`, an epoch millisecond.
   * Resolves to the token to release it with when this call recorded the key,
   * and to `undefined` when the key is already claimed and its claim has not
   * lapsed. Rejects with `ClaimStoreError` when the store cannot answer.
   */
  tryClaim(key: string, expires: number): Promise<ClaimToken | undefined>;
  /**
   * Release the claim on `key` held with `token`. A token releases only the
   * claim it was handed out for, so a caller whose claim lapsed cannot drop
   * the key's current holder. Never rejects: a claim that fails to release
   * only holds its key until it lapses.
   */
  release(key: string, token: ClaimToken): Promise<void>;
}
