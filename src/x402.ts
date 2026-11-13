/**
 * The x402 payment rail: everything specific to x402 lives here.
 *
 * See `mpp.ts` for the MPP rail and `dispatch.ts` for the neutral router that
 * classifies each request and delegates to whichever rail it is paying on.
 */

import { isDeepStrictEqual } from "node:util";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import {
  type FacilitatorClient,
  HTTPFacilitatorClient,
  x402ResourceServer,
} from "@x402/core/server";
import {
  type PaymentPayload,
  type PaymentRequirements,
  type ResourceInfo,
  SettleError,
  type SettleResponse,
  VerifyError,
  type VerifyResponse,
} from "@x402/core/types";
import { findDefaultAsset, getDefaultAsset } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { base, baseSepolia } from "viem/chains";
import type { Call } from "./calls.js";
import type { ClaimStore, ClaimToken } from "./claims/store.js";
import type { X402Config } from "./config.js";
import type { Offer } from "./discovery.js";
import { ENDPOINTS, findEndpoint, ICON_PATH } from "./endpoints.js";
import { AppError, describe, isRecord, jsonError } from "./error.js";
import { log } from "./log.js";
import {
  type Failure,
  failure,
  type Metrics,
  type Outcome,
  outcome,
  seconds,
  step,
} from "./metrics.js";
import type { RestrictedAddressScreener } from "./screener.js";

/**
 * x402 V2 carries its payment proof in the `PAYMENT-SIGNATURE` request header.
 * V1's `X-PAYMENT` is deliberately not recognized: the service is V2-only, so a
 * V1 client carries no payment we accept and falls through to the cold `402`.
 */
const V2_PAYMENT_HEADER = "payment-signature";

/**
 * x402 V2 returns the settlement receipt in the `Payment-Response` response
 * header as base64-encoded JSON, the dual of the `PAYMENT-SIGNATURE` request
 * header.
 */
const PAYMENT_RECEIPT_HEADER = "payment-response";

/**
 * x402 V2 serves the cold `402` requirements in the `Payment-Required` response
 * header as base64-encoded JSON. Header-only clients read nothing else.
 */
export const PAYMENT_REQUIRED_HEADER = "payment-required";

/** The EVM treasury address that receives x402 payments (`payTo`). */
const PAY_TO_EVM = "0xFFa76529d7e733C7671190b374819d8eDA2b9D04";

/** What this rail calls itself in metrics. */
export const RAIL = "x402";

/** Every way a payment on this rail can end, so each starts at zero in metrics. */
export const OUTCOMES = [
  outcome.SETTLED,
  outcome.MALFORMED,
  outcome.NO_OFFER,
  outcome.REFUSED,
  outcome.DUPLICATE,
  outcome.SCREENED_OUT,
  outcome.NETWORK_UNAVAILABLE,
  outcome.SETTLE_FAILED,
  outcome.UPSTREAM_FAILED,
] as const satisfies readonly Outcome[];

/** One of the ways a payment on this rail can end. */
type Ended = (typeof OUTCOMES)[number];

/**
 * The payment method identifier discovery offers carry for this rail. Stated
 * apart from the metrics name, so relabeling one can never move the other.
 */
const X402_METHOD = "x402";

/**
 * The networks this rail sells on, in the order offers are advertised: the
 * CAIP-2 id the protocol names, and the viem definition that names the chain
 * in words. Whether each is a testnet is stated rather than read off the
 * chain, so a definition that stops carrying the flag cannot quietly turn a
 * testnet into money.
 */
const NETWORKS = [
  { caip2: "eip155:84532", chain: baseSepolia, testnet: true },
  { caip2: "eip155:8453", chain: base, testnet: false },
] as const;

/** The x402 protocol version our offers and payments speak. */
const X402_VERSION = 2;

/** How the advertised asset moves. Every offer we make is an EIP-3009 transfer. */
const ASSET_TRANSFER_METHOD = "eip3009";

/** How long an offer stays payable, in seconds. */
const MAX_TIMEOUT_SECONDS = 300;

/** The error line every cold `402` envelope carries. */
const PAYMENT_REQUIRED = "Payment required";

/** Shared message for any payment `decodePayment` cannot read, whatever part failed. */
const MALFORMED_PAYMENT = "malformed x402 payment payload";

/** Shared message for every refused payment, so refusals are indistinguishable. */
const GENERIC_REJECTION = "x402 payment did not verify";

/**
 * Shared message for a payment we could not settle, whether the facilitator
 * declined it or was unreachable, so the client cannot tell the two apart.
 */
const SETTLE_FAILED = "x402 payment could not be settled";

/** Whether the request carries an x402 V2 payment proof. */
export function hasPayment(headers: Headers): boolean {
  return headers.has(V2_PAYMENT_HEADER);
}

/**
 * Build the list of payment offers we can make, one per network in `NETWORKS`.
 * The same entries seed both the cold `402` and payment verification, so there
 * is one source of truth for what we charge. Startup keeps only the ones the
 * facilitator settles, so each deployment offers exactly the networks its
 * facilitator is set up for.
 *
 * Where a facilitator settles both, the testnet leads, so clients that take
 * the first offer they support pay with faucet money rather than the real thing.
 */
export function accepts(): Map<string, PaymentRequirements[]> {
  return new Map<string, PaymentRequirements[]>(
    ENDPOINTS.map((endpoint) => [
      endpoint.path,
      NETWORKS.map(({ caip2 }) => {
        const asset = getDefaultAsset(caip2);
        return {
          scheme: "exact",
          network: caip2,
          amount: String(endpoint.priceBaseUnits),
          asset: asset.asset,
          payTo: PAY_TO_EVM,
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: {
            assetTransferMethod: ASSET_TRANSFER_METHOD,
            name: asset.name,
            version: asset.version,
          },
        } as PaymentRequirements;
      }),
    ]),
  );
}

/**
 * How this service is named in a facilitator's catalog. At most 32 printable
 * ASCII characters.
 */
const SERVICE_NAME = "Brave Search";

/**
 * Catalog keywords for the service as a whole, since a catalog keeps no tags per
 * path. At most five, under the same limit as the name. A catalog keeps the first
 * five it can read and counts two that differ only in case as one.
 */
const SERVICE_TAGS = ["search", "web", "news", "images", "llm"];

/**
 * The `resource` a catalog lists `url` under: what it is, and the service it
 * belongs to. The icon is the one this service serves on the origin of `url`,
 * left out when `url` is not a URL.
 */
function catalogResource(url: string, description: string): ResourceInfo {
  const resource: ResourceInfo = {
    url,
    description,
    mimeType: "application/json",
    serviceName: SERVICE_NAME,
    tags: SERVICE_TAGS,
  };
  try {
    resource.iconUrl = new URL(ICON_PATH, url).href;
  } catch {
    // Not a URL, so there is no origin to serve an icon from.
  }
  return resource;
}

/**
 * How to call a paid path. `info` states a sample call and what it returns, and
 * `schema` is the JSON Schema the call must satisfy. A facilitator refuses a
 * declaration whose `info` does not satisfy its own `schema`.
 *
 * The method stays GET for a HEAD request, because only GET returns the data
 * being bought.
 */
function bazaarDeclaration(call: Call): Record<string, unknown> {
  return {
    info: {
      input: { type: "http", method: "GET", queryParams: call.query },
      output: { type: "json", example: call.response },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["GET"] },
            queryParams: { type: "object", properties: call.params, required: call.required },
          },
          required: ["type", "method"],
        },
        output: {
          type: "object",
          properties: { type: { type: "string" }, example: schemaOf(call.response) },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  };
}

/**
 * A JSON Schema stating the type of every field `example` shows, so a catalog
 * can describe the response. Derived from the example rather than written out,
 * so the two cannot drift apart. No field is marked required, since Brave leaves
 * out what a result does not have. Every number is a `number`, since a sample
 * value that happens to be whole says nothing about the next one.
 */
function schemaOf(example: unknown): Record<string, unknown> {
  if (Array.isArray(example)) {
    const [first] = example;
    return first === undefined ? { type: "array" } : { type: "array", items: schemaOf(first) };
  }
  if (example === null) {
    return { type: "null" };
  }
  if (typeof example === "object") {
    const properties = Object.entries(example).map(([name, value]) => [name, schemaOf(value)]);
    return { type: "object", properties: Object.fromEntries(properties) };
  }
  return { type: typeof example };
}

/**
 * The route binding mppx needs before it will sign, under the key it reads.
 *
 * Both members are required: dropping either fails the payment with "requires
 * route binding", even though nothing reads inside `schema`. We do not verify
 * the binding. It only feeds the client's nonce, and the facilitator is what
 * checks the signature.
 *
 * `bazaar` rides alongside it when the deployment is listed: a facilitator that
 * keeps a catalog lists the path once a payment for it settles, and one that
 * keeps none ignores the key.
 */
function routeExtensions(method: string, call: Call, listed: boolean): Record<string, unknown> {
  const mppx = { info: { method }, schema: { type: "object" } };
  return listed ? { mppx, bazaar: bazaarDeclaration(call) } : { mppx };
}

/**
 * The x402 resource server and the payment offers we accept, wrapped so the rest
 * of the service names this module's type rather than the SDK's.
 */
export interface Client {
  /** Verifies and settles payments through the facilitator. */
  server: x402ResourceServer;
  /**
   * Offers per paid path, built once at startup. The cold `402` for a path
   * advertises exactly that path's entries and a payment must accept one of
   * them, so the two can never disagree and no path is payable at another's
   * price.
   */
  accepts: Map<string, PaymentRequirements[]>;
  /**
   * Claims over payment replay keys. A payment's key is claimed before any
   * facilitator or upstream call and held while the payment is in flight and
   * briefly after the facilitator decides on it, so one payment buys at most
   * one search. The store's scope and bounds are documented in `claims/store.ts`.
   */
  claims: ClaimStore;
  /** Whether the paid paths are offered to facilitator catalogs. */
  enableBazaar: boolean;
}

/**
 * Build the x402 client from the rail's settings. A bad `X402_FACILITATOR_URL`
 * is a startup misconfiguration.
 */
export function client(rail: X402Config, claims: ClaimStore): Client {
  try {
    // Parsed only to reject a URL we could never call; the string is passed on
    // as configured, so the facilitator sees exactly the base it was given.
    new URL(rail.facilitatorUrl);
  } catch (err) {
    throw AppError.invalidConfig(`X402_FACILITATOR_URL: ${describe(err)}`);
  }
  return {
    server: resourceServer(new HTTPFacilitatorClient({ url: rail.facilitatorUrl })),
    accepts: accepts(),
    claims,
    enableBazaar: rail.enableBazaar,
  };
}

/** The SDK's resource server over `facilitator`, with the exact scheme on each of `NETWORKS`. */
export function resourceServer(facilitator: FacilitatorClient): x402ResourceServer {
  return registerExactEvmScheme(new x402ResourceServer(facilitator), {
    networks: NETWORKS.map(({ caip2 }) => caip2),
  });
}

/**
 * How long startup keeps asking the facilitator what it supports. A deploy
 * stops the old facilitator before the new one starts, so it can be away for a
 * few minutes. This outlasts that and stays inside the time the startup probe
 * gives the service.
 */
const SUPPORT_DEADLINE_MS = 180_000;

/** The wait before asking again, doubled after each failure up to the cap. */
const SUPPORT_FIRST_DELAY_MS = 1_000;
const SUPPORT_MAX_DELAY_MS = 15_000;

/**
 * Load what the facilitator supports into `server`, asking again with a
 * growing wait while that fails, for up to `deadlineMs`. The last failure is
 * thrown once the next wait would pass the deadline.
 */
export async function loadSupported(
  server: x402ResourceServer,
  deadlineMs = SUPPORT_DEADLINE_MS,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (let delay = SUPPORT_FIRST_DELAY_MS; ; delay = Math.min(delay * 2, SUPPORT_MAX_DELAY_MS)) {
    try {
      await server.initialize();
      return;
    } catch (err) {
      if (Date.now() + delay > deadline) {
        throw err;
      }
      log.warn(`x402 facilitator not ready, asking again in ${delay / 1000}s: ${describe(err)}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Build the client and load what the facilitator supports, which the resource
 * server routes payments by. Only offers the facilitator can settle are kept,
 * so a client never picks one that verify would refuse. A facilitator that
 * stays unreachable past the retry window, or settles none of our offers,
 * stops startup.
 */
export async function start(rail: X402Config, claims: ClaimStore): Promise<Client> {
  const built = client(rail, claims);
  try {
    await loadSupported(built.server);
  } catch (err) {
    throw AppError.invalidConfig(`X402_FACILITATOR_URL: ${describe(err)}`);
  }
  const settleable = new Map(
    [...built.accepts].map(([path, offers]) => [
      path,
      offers.filter(
        ({ network, scheme }) =>
          built.server.getSupportedKind(X402_VERSION, network, scheme) !== undefined,
      ),
    ]),
  );
  if ([...settleable.values()].every((offers) => offers.length === 0)) {
    throw AppError.invalidConfig(
      "X402_FACILITATOR_URL: the facilitator settles none of the networks we offer",
    );
  }
  return { ...built, accepts: settleable };
}

/**
 * x402's part of the cold `402`: the V2 `PaymentRequired` envelope for
 * `resource`, base64 encoded into the `Payment-Required` header, the V2
 * transport clients read. `undefined` if it cannot be encoded, leaving the `402`
 * advertising MPP alone.
 */
export function challenge(
  client: Client,
  resource: string,
  method: string,
): { name: string; value: string } | undefined {
  const path = pathOf(resource);
  // Advertise this endpoint's price and no other. A client that is offered every
  // price at once could pay the cheapest and call the dearest.
  const endpoint = findEndpoint(path);
  const offers = client.accepts.get(path);
  if (endpoint === undefined || offers === undefined) {
    log.error(`no x402 offer for a paid path: ${path}`);
    return undefined;
  }
  const envelope = {
    x402Version: X402_VERSION,
    error: PAYMENT_REQUIRED,
    resource: catalogResource(resource, endpoint.description),
    accepts: offers,
    extensions: routeExtensions(method, endpoint.call, client.enableBazaar),
  };
  try {
    return { name: PAYMENT_REQUIRED_HEADER, value: encodePaymentRequiredHeader(envelope) };
  } catch {
    log.error("x402 challenge could not be encoded as a header");
    return undefined;
  }
}

/**
 * The resource a payment is relayed under, and the declaration that goes with it,
 * built from the request this service served rather than from anything the payer
 * said about it.
 *
 * Origin and path only, so what was searched stays between the payer and this
 * service.
 *
 * `undefined` for a request this service cannot name, which relays no resource at
 * all: no host, a scheme other than HTTPS, or a path it does not sell.
 */
function relayedResource(
  requested: string,
): { resource: ResourceInfo; declaration: Record<string, unknown> } | undefined {
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") {
    return undefined;
  }
  const endpoint = findEndpoint(url.pathname);
  if (endpoint === undefined) {
    return undefined;
  }
  return {
    resource: catalogResource(`${url.origin}${url.pathname}`, endpoint.description),
    declaration: bazaarDeclaration(endpoint.call),
  };
}

/** The path part of a resource URL, or the whole string when it is not a URL. */
function pathOf(resource: string): string {
  try {
    return new URL(resource, "http://placeholder.invalid").pathname;
  } catch {
    return resource;
  }
}

/**
 * The offers this rail states in the discovery document for `path`: one per
 * advertised network, in the order the cold `402` lists them. Read off the
 * `accepts` table, so discovery can never disagree with the challenge. Empty
 * for a path that is not sold.
 */
/** Whether any offer this rail makes settles on a testnet. */
export function servesTestnet(client: Client): boolean {
  return [...client.accepts.values()]
    .flat()
    .some((entry) => NETWORKS.find((network) => network.caip2 === entry.network)?.testnet);
}

export function offers(client: Client, path: string): Offer[] {
  return (client.accepts.get(path) ?? []).map((entry) => ({
    intent: "charge",
    method: X402_METHOD,
    amount: entry.amount,
    currency: entry.asset,
    description: describeOffer(entry),
  }));
}

/**
 * One advertised requirement's token and chain in words. The discovery offer
 * object has no network field, so this sentence is the only place a reader
 * learns which chain an offer settles on. The fallbacks cannot fire for
 * entries built by `accepts`, but an unknown network or asset is still named
 * by its identifier rather than dropped or thrown on.
 */
function describeOffer(entry: PaymentRequirements): string {
  const symbol = findDefaultAsset(entry.asset, entry.network)?.symbol ?? entry.asset;
  const network = NETWORKS.find((candidate) => candidate.caip2 === entry.network);
  if (network === undefined) {
    return `${symbol} on ${entry.network}`;
  }
  return `${symbol} on ${network.chain.name}${network.testnet ? " (testnet)" : ""}`;
}

/**
 * Drive the x402 pay flow for a request that carries a payment proof: verify,
 * run the search, then settle, each step gating the next. A caller is never
 * charged for a response they do not get, nor served one they did not pay for:
 *
 * - payment missing, malformed, or rejected: `402`, before any upstream call.
 * - payment already in flight or recently decided: `402`, before any
 *   facilitator call.
 * - replay claim store unreachable: `502`, before any facilitator call.
 * - facilitator unreachable on verify: `502`.
 * - search fails (4xx or 5xx): relayed as is, settlement skipped.
 * - settlement fails: `502`, the response body withheld.
 * - settlement reported pending with a transaction: asked about once more, then
 *   served or `502` by that answer.
 *
 * `requested` is the absolute URL being paid for, which the payment is relayed as
 * having bought.
 */
export async function handle(
  client: Client,
  screener: RestrictedAddressScreener | undefined,
  metrics: Metrics,
  endpoint: string,
  requested: string,
  headers: Headers,
  runSearch: () => Promise<Response>,
): Promise<Response> {
  // Every exit below records how the payment ended, so no path goes uncounted.
  const ended = (label: Ended, response: Response): Response => {
    metrics.recordPayment(RAIL, endpoint, label);
    return response;
  };

  const decoded = decodePayment(headers, requested, client.enableBazaar);
  if (typeof decoded === "string") {
    metrics.recordFailure(RAIL, step.DECODE, decoded);
    return ended(outcome.MALFORMED, paymentRejected(MALFORMED_PAYMENT));
  }
  const { payload, accepted, payer, claim } = decoded;

  // The payer must accept an offer we advertised for the path it is calling, so
  // it can name neither its own price, asset, and recipient, nor another
  // endpoint's cheaper offer. Refused like any other payment we decline.
  const offer = client.accepts.get(endpoint)?.find((entry) => isDeepStrictEqual(entry, accepted));
  if (offer === undefined) {
    return ended(outcome.NO_OFFER, paymentRejected(GENERIC_REJECTION));
  }

  // One payment buys one search. The key is claimed before anything else
  // touches the payment, and the store records a key once however many
  // requests race for it, so concurrent requests carrying the same payment are
  // refused here before they reach the screener, the facilitator, or the
  // upstream. Refused like any other payment we decline, so a duplicate learns
  // nothing new.
  //
  // The key also names the rail, network, and token: the store is shared with
  // the other rail, and a nonce is only unique per token contract.
  const key = `${RAIL}:${offer.network}:${offer.asset.toLowerCase()}:${claim.key}`;

  // A store that cannot answer is our failure, not the client's, so it is a
  // 502 and the payment is never checked or served.
  const claimStarted = performance.now();
  let token: ClaimToken | undefined;
  try {
    token = await client.claims.tryClaim(key, claim.expires);
  } catch (err) {
    metrics.recordFailure(RAIL, step.CLAIM, failure.UNREACHABLE);
    log.error(`x402 replay claim failed: ${describe(err)}`);
    return ended(outcome.NETWORK_UNAVAILABLE, gatewayError("payment could not be checked"));
  } finally {
    metrics.recordPaymentStep(RAIL, step.CLAIM, seconds(claimStarted));
  }
  if (token === undefined) {
    return ended(outcome.DUPLICATE, paymentRejected(GENERIC_REJECTION));
  }

  // The claim is released when the payment never reached a settlement
  // decision, so a payment failing through no fault of its own can be
  // retried. Once the facilitator decides, either way, the claim is kept
  // until it lapses: a settled payment must not buy another search, and
  // retrying a refused settlement would buy a search per attempt.
  let decided = false;
  try {
    // Screen the payer before any facilitator or upstream call, so a blocked
    // signer touches neither.
    if (screener !== undefined) {
      const denied = await screener.requireAllowed(payer, paymentRejected(GENERIC_REJECTION));
      if (denied !== undefined) {
        return ended(outcome.SCREENED_OUT, denied);
      }
    }

    // Verify before doing any work. A facilitator we cannot reach is our
    // failure, not the client's, so it is a 502 rather than a 402. A facilitator
    // that refuses the payment with an error status still refused it.
    const verifyStarted = performance.now();
    let verified: VerifyResponse;
    try {
      verified = await client.server.verifyPayment(payload, offer);
    } catch (err) {
      metrics.recordPaymentStep(RAIL, step.VERIFY, seconds(verifyStarted));
      if (err instanceof VerifyError) {
        metrics.recordFailure(RAIL, step.VERIFY, refusedBecause(err));
        return ended(outcome.REFUSED, paymentRejected(GENERIC_REJECTION));
      }
      metrics.recordFailure(RAIL, step.VERIFY, failure.UNREACHABLE);
      log.error(`x402 facilitator verify failed: ${describe(err)}`);
      return ended(outcome.NETWORK_UNAVAILABLE, gatewayError("payment facilitator unavailable"));
    }
    metrics.recordPaymentStep(RAIL, step.VERIFY, seconds(verifyStarted));
    if (verified.isValid !== true) {
      metrics.recordFailure(RAIL, step.VERIFY, refusedBecause(verified));
      return ended(outcome.REFUSED, paymentRejected(GENERIC_REJECTION));
    }
    // The payer the facilitator verified must be the one the payment names.
    if (verified.payer !== undefined && verified.payer.toLowerCase() !== payer) {
      metrics.recordFailure(RAIL, step.VERIFY, failure.PAYER_MISMATCH);
      return ended(outcome.REFUSED, paymentRejected(GENERIC_REJECTION));
    }

    const response = await runSearch();
    if (!response.ok) {
      return ended(outcome.UPSTREAM_FAILED, response);
    }

    // The value we verified settles unchanged. Withhold the already produced
    // body unless it settles.
    const settleStarted = performance.now();
    let receipt: SettleResponse;
    try {
      receipt = await client.server.settlePayment(payload, offer);
    } catch (err) {
      metrics.recordPaymentStep(RAIL, step.SETTLE, seconds(settleStarted));
      // A facilitator that refuses with an error status still decided.
      decided = err instanceof SettleError;
      metrics.recordFailure(
        RAIL,
        step.SETTLE,
        err instanceof SettleError ? refusedBecause(err) : failure.UNREACHABLE,
      );
      log.error(`x402 facilitator settle failed: ${describe(err)}`);
      return ended(outcome.SETTLE_FAILED, gatewayError(SETTLE_FAILED));
    }
    metrics.recordPaymentStep(RAIL, step.SETTLE, seconds(settleStarted));
    decided = true;
    if (receipt.success !== true) {
      metrics.recordFailure(RAIL, step.SETTLE, refusedBecause(receipt));
      log.error(`x402 facilitator reported settlement failure: ${JSON.stringify(receipt)}`);
      return ended(outcome.SETTLE_FAILED, gatewayError(SETTLE_FAILED));
    }

    metrics.recordPayment(RAIL, endpoint, outcome.SETTLED);
    metrics.recordPayer(RAIL, payer);
    // The price comes from the catalog, so what we count as earned is what we
    // advertised rather than anything the payer said.
    const sold = findEndpoint(endpoint);
    if (sold !== undefined) {
      metrics.recordCharge(RAIL, endpoint, describeOffer(offer), sold.priceBaseUnits);
    }
    return attachReceipt(response, receipt);
  } finally {
    if (!decided) {
      await client.claims.release(key, token);
    }
  }
}

/**
 * Wording a facilitator uses for a proof that has already been spent.
 *
 * The reason code for that case is `invalid_payload`, the same code a malformed
 * proof gets, so the message is the only thing separating a replayed payment
 * from a broken one. This only ever picks a label on a counter: a facilitator
 * that words it differently counts as an invalid payment, and nothing about the
 * refusal the caller sees depends on it.
 */
const ALREADY_SPENT = ["already submitted", "already used", "nonce already"];

/**
 * Why the facilitator refused, read from what it reported. Takes the refusal
 * itself, which is a verify answer, a settle answer, or either error the SDK
 * throws for them, so all four read the same at the call site.
 *
 * A reason we have no bucket for counts as `other`, so a facilitator cannot
 * grow the metric one label at a time.
 */
function refusedBecause(refusal: {
  invalidReason?: string;
  invalidMessage?: string;
  errorReason?: string;
  errorMessage?: string;
}): Failure {
  const reason = refusal.invalidReason ?? refusal.errorReason;
  if (reason === undefined || reason === "") {
    return failure.UNSPECIFIED;
  }
  const code = reason.toLowerCase();
  // The exact EVM scheme says "insufficient_balance" for a payer short of the
  // token, other facilitators say "insufficient_funds".
  if (code.includes("insufficient_funds") || code.includes("insufficient_balance")) {
    return failure.INSUFFICIENT_FUNDS;
  }
  if (code.includes("valid_before") || code.includes("valid_after") || code.includes("expired")) {
    return failure.EXPIRED;
  }
  if (code.includes("pending")) {
    return failure.PENDING;
  }
  if (code.startsWith("invalid") || code.startsWith("unsupported")) {
    // Only a refusal that is already about the payload can be a spent proof,
    // so the wording is read here rather than ahead of the codes, where a
    // message mentioning a used nonce could outrank what the facilitator
    // actually said.
    const wording = (refusal.invalidMessage ?? refusal.errorMessage ?? "").toLowerCase();
    return ALREADY_SPENT.some((spent) => wording.includes(spent))
      ? failure.ALREADY_USED
      : failure.INVALID_PAYMENT;
  }
  return failure.OTHER;
}

/** The authorization fields a payment must carry: an EVM address and a 32-byte nonce. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EIP3009_NONCE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Decode the client's base64 JSON payment from `PAYMENT-SIGNATURE` into the raw
 * payload, the offer the payer says it accepted, the payer to screen,
 * lowercased to the screener's canonical form (EVM addresses are
 * case-insensitive hex), and the replay claim the payment is deduplicated
 * under. Otherwise the `failure` reason saying which part could not be read:
 * the header is absent or not the base64 JSON required, it names no accepted
 * offer, or it carries no well-formed eip3009 authorization.
 *
 * Every offer we advertise is an eip3009 transfer, so a payload without a
 * plausible `authorization` is malformed for all of them and is refused here,
 * before it can reach the screener or the facilitator carrying no identity.
 * What is relayed is rebuilt from that `authorization` and its signature alone.
 *
 * The resource the client echoed is replaced with `relayedResource`, and the
 * discovery declaration restated, before anything leaves for the facilitator: a
 * catalog records a settled payment against the resource the payload names, so a
 * payer would otherwise choose how this service is listed. Both are dropped for a
 * request this service cannot name, and whenever `listed` is off, since a catalog
 * reads the pair.
 */
export function decodePayment(
  headers: Headers,
  requested: string,
  listed: boolean,
):
  | {
      payload: PaymentPayload;
      accepted: PaymentRequirements;
      payer: string;
      claim: { key: string; expires: number };
    }
  | Failure {
  const header = headers.get(V2_PAYMENT_HEADER);
  if (header === null) {
    return failure.UNDECODABLE;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return failure.UNDECODABLE;
  }
  if (!isRecord(payload)) {
    return failure.UNDECODABLE;
  }
  // An x402 v1 payload names its scheme and network at the top level instead,
  // so it lands here whatever version it claims.
  const { accepted } = payload;
  if (!isRecord(accepted)) {
    return failure.MISSING_OFFER;
  }
  const transfer = isRecord(payload.payload) ? payload.payload : undefined;
  const authorization = transfer?.authorization;
  if (!isRecord(authorization)) {
    return failure.MISSING_AUTHORIZATION;
  }
  const { from, nonce } = authorization;
  if (typeof from !== "string" || !EVM_ADDRESS.test(from)) {
    return failure.BAD_PAYER;
  }
  if (typeof nonce !== "string" || !EIP3009_NONCE.test(nonce)) {
    return failure.BAD_NONCE;
  }
  const payer = from.toLowerCase();
  // The transfer is relayed in the eip3009 shape the SDK client builds, so
  // nothing the payer added beside the authorization goes on.
  payload.payload = { authorization, signature: transfer?.signature };
  const echoed = isRecord(payload.extensions) ? payload.extensions : undefined;
  const relayed = listed ? relayedResource(requested) : undefined;
  delete payload.resource;
  delete echoed?.bazaar;
  if (relayed !== undefined) {
    payload.resource = relayed.resource;
    payload.extensions = { ...echoed, bazaar: relayed.declaration };
  }
  return {
    payload: payload as PaymentPayload,
    accepted: accepted as PaymentRequirements,
    payer,
    claim: {
      // The nonce is what settlement consumes on chain, so however a client
      // re-encodes one payment it always maps to one key. The window is the
      // fixed offer timeout rather than the client's own deadline, so a
      // sender cannot shorten how long its payment is held against
      // duplicates.
      key: `${payer}:${nonce.toLowerCase()}`,
      expires: Date.now() + MAX_TIMEOUT_SECONDS * 1000,
    },
  };
}

/**
 * Attach the settlement receipt as the base64 `Payment-Response` header the
 * client reads back, leaving the response body untouched.
 */
function attachReceipt(response: Response, receipt: SettleResponse): Response {
  const headers = new Headers(response.headers);
  try {
    headers.set(PAYMENT_RECEIPT_HEADER, encodePaymentResponseHeader(receipt));
  } catch {
    return response;
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** A `402` telling the client their x402 payment was missing, malformed, or rejected. */
function paymentRejected(detail: string): Response {
  return jsonError(402, detail);
}

/** A `502` for a payment we could neither verify nor settle through the facilitator. */
function gatewayError(detail: string): Response {
  return jsonError(502, detail);
}
