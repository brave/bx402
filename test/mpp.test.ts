import { Challenge, Credential, Errors, Receipt } from "mppx";
import { Attribution } from "mppx/tempo";
import * as Secp256k1 from "ox/Secp256k1";
import { TxEnvelopeTempo } from "ox/tempo";
import { encodeFunctionData, HttpRequestError } from "viem";
import { Abis } from "viem/tempo";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryClaimStore } from "../src/claims/memory.js";
import { type ClaimStore, ClaimStoreError, type ClaimToken } from "../src/claims/store.js";
import type { Config, MppConfig } from "../src/config.js";
import { Metrics } from "../src/metrics.js";
import type { Charge, Client } from "../src/mpp.js";
import {
  challenge,
  client,
  credential,
  handle,
  offers,
  replayStore,
  servesTestnet,
  signerAddress,
  transactionPayload,
} from "../src/mpp.js";
import {
  assertNotRecorded,
  assertRecorded,
  forgedTransaction,
  mockOrigin,
  mockTempoRpc,
  restoreNetwork,
  TEST_TEMPO_RPC,
  testConfig,
} from "./support.js";

/** Tempo mainnet and the Moderato testnet, the two chains this rail serves. */
const MAINNET = 4217;
const MODERATO = 42431;

/**
 * The tokens each chain accepts, in offer order, written out here so the table
 * in src is checked rather than copied.
 */
const OUSD = { address: "0x20c0000000000000000000006a37DA5C996874BE", symbol: "OUSD" };
const PATH_USD = { address: "0x20c0000000000000000000000000000000000000", symbol: "pathUSD" };
const TOKENS = new Map<number, { address: string; symbol: string }[]>([
  [
    MAINNET,
    [OUSD, { address: "0x20c000000000000000000000b9537d11c60e8b50", symbol: "USDC.e" }, PATH_USD],
  ],
  [
    MODERATO,
    [OUSD, { address: "0x20c0000000000000000000009e8d7eb59b783726", symbol: "USDC.e" }, PATH_USD],
  ],
]);

/** The path every test that needs one paid endpoint uses. */
const WEB_SEARCH_PATH = "/res/v1/web/search";

/** The rail settings out of a test config that enables MPP. */
function mppRail(config: Config): MppConfig {
  if (config.mpp === undefined) {
    throw new Error("the test config enables the MPP rail");
  }
  return config.mpp;
}

/**
 * Build the client against an endpoint that reports `chain`. Only the endpoint is
 * canned; the build itself is the production path.
 */
async function clientOn(config: Config, chain: number) {
  mockTempoRpc(chain);
  return client(mppRail(config), new MemoryClaimStore(), new Metrics());
}

/**
 * A minimal challenge to sit beside a payload, so the payload gate reads only
 * what is next to it rather than anything this echo says.
 */
function echo(): Challenge.Challenge {
  return {
    id: "id",
    realm: "bx402",
    method: "tempo",
    intent: "charge",
    request: {},
  } as Challenge.Challenge;
}

/** Headers carrying a credential that answers `minted` with a signed transaction. */
function answering(minted: Challenge.Challenge): Headers {
  return new Headers({
    authorization: Credential.serialize(
      Credential.from({
        challenge: minted,
        payload: { type: "transaction", signature: forgedTransaction().transaction },
      }),
    ),
  });
}

/**
 * Headers carrying a credential that pays `minted` in full: a signed transfer
 * of the charged amount to the charged recipient, its memo bound to the
 * challenge. The SDK accepts it up to the broadcast, so a charge driven with it
 * goes through every check that comes before moving money.
 */
function paying(minted: Challenge.Challenge): Headers {
  const { amount, currency, recipient } = minted.request as Record<string, string>;
  const envelope = TxEnvelopeTempo.from({
    type: "tempo",
    chainId: MODERATO,
    calls: [
      {
        to: currency as `0x${string}`,
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: "transferWithMemo",
          args: [
            recipient as `0x${string}`,
            BigInt(amount as string),
            Attribution.encode({ challengeId: minted.id, serverId: minted.realm }),
          ],
        }),
      },
    ],
    gas: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    nonce: 0n,
  });
  const signature = Secp256k1.sign({
    payload: TxEnvelopeTempo.getSignPayload(envelope),
    privateKey: Secp256k1.randomPrivateKey(),
  });
  return new Headers({
    authorization: Credential.serialize(
      Credential.from({
        challenge: minted,
        payload: {
          type: "transaction",
          signature: TxEnvelopeTempo.serialize(envelope, { signature }),
        },
      }),
    ),
  });
}

/**
 * Queue answers from the Tempo endpoint, one per call in order: `undefined`
 * answers a simulation with success, a string refuses the call with that
 * message. A call past the queue finds nothing and fails as unreachable.
 */
function tempoAnswers(...answers: (string | undefined)[]): void {
  for (const answer of answers) {
    mockOrigin(TEST_TEMPO_RPC)
      .intercept({ method: "POST", path: "/" })
      .reply(
        200,
        answer === undefined
          ? { jsonrpc: "2.0", id: 1, result: "0x" }
          : { jsonrpc: "2.0", id: 1, error: { code: -32000, message: answer } },
      );
  }
}

/** A claim store that records every call the rail makes into it. */
function recording(claims: ClaimStore): { store: ClaimStore; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    store: {
      tryClaim: (key: string, expires: number) => {
        calls.push(`claim ${key}`);
        return claims.tryClaim(key, expires);
      },
      release: (key: string, token: ClaimToken) => {
        calls.push(`release ${key}`);
        return claims.release(key, token);
      },
      drop: (key: string) => {
        calls.push(`drop ${key}`);
        return claims.drop(key);
      },
    },
  };
}

/**
 * A client charging through the SDK's own charge over a recording claim store,
 * with headers paying its first challenge.
 */
async function realCharge(metrics: Metrics) {
  const claims = new MemoryClaimStore();
  const { store, calls } = recording(claims);
  const built = await client(mppRail(testConfig()), store, metrics);
  const advertised = await challenge(built, WEB_SEARCH_PATH);
  const [minted] = Challenge.deserializeList(advertised?.value as string);
  return { built, headers: paying(minted as Challenge.Challenge), claims, calls };
}

afterEach(() => {
  restoreNetwork();
});

describe("mpp", () => {
  it("client_requires_a_usable_endpoint", async () => {
    // Both die in the startup chain query, the first step of the build.
    for (const endpoint of ["not a url", "http://127.0.0.1:1"]) {
      const rail = { ...mppRail(testConfig()), rpcUrl: endpoint };
      await expect(
        client(rail, new MemoryClaimStore(), new Metrics()),
        `case: ${endpoint}`,
      ).rejects.toThrow("invalid configuration");
    }
  });

  it("serves_whichever_known_chain_the_endpoint_reports", async () => {
    // The endpoint alone decides the network, testnet or not.
    for (const chain of [MODERATO, MAINNET]) {
      expect(servesTestnet(await clientOn(testConfig(), chain)), `chain ${chain}`).toBe(
        chain === MODERATO,
      );
      restoreNetwork();
    }
  });

  it("challenge_advertises_the_charge_credentials_answer", async () => {
    const built = await clientOn(testConfig(), MODERATO);
    const advertised = await challenge(built, WEB_SEARCH_PATH);
    expect(advertised?.name).toBe("www-authenticate");

    // One challenge per accepted token, in the order they are offered.
    const parsed = Challenge.deserializeList(advertised?.value as string);
    for (const one of parsed) {
      expect(one.realm).toBe("bx402");
      expect(one.method).toBe("tempo");
      expect(one.intent).toBe("charge");
      // Signed and time-boxed, so only a credential answering this challenge pays.
      expect(one.id).not.toBe("");
      expect(one.expires).toBeDefined();
    }
    expect(new Set(parsed.map((one) => one.id)).size).toBe(parsed.length);

    // The charges a credential is verified against, byte for byte. `amount` is in
    // base units here while the charge table holds the decimal the SDK scales
    // from, so this is what pins the price that actually reaches a payer.
    expect(parsed.map((one) => one.request)).toEqual(
      TOKENS.get(MODERATO)?.map(({ address }) => ({
        amount: "5000",
        currency: address,
        methodDetails: { chainId: MODERATO },
        recipient: "0xbd9420A98a7Bd6B89765e5715e169481602D9c3d",
      })),
    );
  });

  it("challenge_needs_a_charge_for_the_path", async () => {
    const built = await clientOn(testConfig(), MODERATO);
    expect(await challenge(built, "/res/v1/chat/completions")).toBeUndefined();
  });

  it("the_charge_follows_the_chain_and_pins_the_price", async () => {
    for (const chain of [MODERATO, MAINNET]) {
      const built = await clientOn(testConfig(), chain);
      // One price for every token the chain accepts, paid to our treasury.
      expect(built.charges.get(WEB_SEARCH_PATH), `${chain}`).toEqual({
        amount: "0.005",
        chainId: chain,
        decimals: 6,
        recipient: "0xbd9420A98a7Bd6B89765e5715e169481602D9c3d",
      });
    }
    // Any other chain is refused rather than served with a default token.
    await expect(clientOn(testConfig(), 1)).rejects.toThrow("unsupported Tempo chain 1");
  });

  it("a_credential_for_any_of_our_challenges_reaches_the_transfer_check", async () => {
    for (const chain of [MODERATO, MAINNET]) {
      const built = await clientOn(testConfig(), chain);
      const advertised = await challenge(built, WEB_SEARCH_PATH);
      const minted = Challenge.deserializeList(advertised?.value as string);
      expect(minted.map((one) => one.request.currency)).toEqual(
        TOKENS.get(chain)?.map(({ address }) => address),
      );
      const charge = built.charges.get(WEB_SEARCH_PATH);
      for (const one of minted) {
        const parsed = Credential.from({
          challenge: one,
          payload: { type: "transaction", signature: forgedTransaction().transaction },
        });
        // The real SDK handler, given the request exactly as `handle` gives it.
        // The forged transaction pays no one, so the charge fails, but only once
        // the SDK has matched the credential to exactly one method and gone
        // looking for the transfer.
        await expect(
          built.handler.broadcastCredential(parsed, { request: { ...charge } }),
          `${chain} ${one.request.currency}`,
        ).rejects.toThrow("no matching payment call found");
      }
      restoreNetwork();
    }
  });

  it("a_credential_in_a_token_we_do_not_offer_is_refused_before_any_charge", async () => {
    const built = await clientOn(testConfig(), MODERATO);
    // Signed by us, so it passes every check except the token being one we sell.
    const minted = await built.handler.challenge.tempo.charge({
      ...(built.charges.get(WEB_SEARCH_PATH) as Charge),
      currency: `0x${"77".repeat(20)}`,
    });
    const metrics = new Metrics();
    const response = await handle(
      built,
      undefined,
      metrics,
      WEB_SEARCH_PATH,
      answering(minted),
      () => Promise.reject(new Error("the search must never run")),
    );

    expect(response.status).toBe(402);
    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",outcome="no_offer"} 1`,
    );
    await assertNotRecorded(metrics, 'step="charge"');
  });

  it("discovery_offers_restate_the_charge_in_base_units", async () => {
    const built = await clientOn(testConfig(), MODERATO);
    // The charge behind this offer reads "0.005"; the offer states base units.
    expect(offers(built, WEB_SEARCH_PATH)).toEqual(
      TOKENS.get(MODERATO)?.map(({ address, symbol }) => ({
        intent: "charge",
        method: "tempo",
        amount: "5000",
        currency: address,
        description: `${symbol} on Tempo Testnet (Moderato)`,
      })),
    );
  });

  it("discovery_offers_name_the_chain_the_deployment_settles_on", async () => {
    // A moderato deployment must not read as mainnet, or the reverse.
    const built = await clientOn(testConfig(), MAINNET);
    expect(offers(built, WEB_SEARCH_PATH).map((offer) => offer.description)).toEqual(
      TOKENS.get(MAINNET)?.map(({ symbol }) => `${symbol} on Tempo Mainnet`),
    );
  });

  it("discovery_offers_are_empty_for_a_path_that_is_not_sold", async () => {
    const built = await clientOn(testConfig(), MODERATO);
    expect(offers(built, "/res/v1/answers/search")).toEqual([]);
  });

  it("only_a_signed_transaction_payload_pays", () => {
    interface PayloadCase {
      /** Label printed if the assertion fails. */
      name: string;
      /** The credential payload to offer. */
      payload: unknown;
      /** Whether that payload is one this rail broadcasts. */
      expected: boolean;
    }
    const cases: PayloadCase[] = [
      {
        name: "transaction",
        payload: { type: "transaction", signature: "0xsigned" },
        expected: true,
      },
      { name: "hash", payload: { type: "hash", hash: "0xhash" }, expected: false },
      { name: "proof", payload: { type: "proof", signature: "0xsig" }, expected: false },
      { name: "arbitrary json", payload: { type: "mystery" }, expected: false },
    ];
    for (const { name, payload, expected } of cases) {
      const parsed = { challenge: echo(), payload } as Credential.Credential;
      expect(transactionPayload(parsed) !== undefined, `case: ${name}`).toBe(expected);
    }
  });

  it("signer_recovery_matches_the_signing_key", () => {
    // The recovery decodes the transaction independently of the SDK, so it must
    // land on exactly the key that signed it.
    const { transaction, signer } = forgedTransaction();
    expect(signerAddress({ type: "transaction", signature: transaction })).toBe(signer);
  });

  it("signer_recovery_requires_a_decodable_signed_transaction", () => {
    const cases: [string, string][] = [
      ["garbage hex", "0xno"],
      ["not hex at all", "zzz"],
      ["empty", ""],
      ["not a tempo transaction", "0x02f8"],
    ];
    for (const [name, signature] of cases) {
      expect(signerAddress({ type: "transaction", signature }), `case: ${name}`).toBeUndefined();
    }
  });

  it("credential_requires_the_payment_scheme", () => {
    const cases: [string, string][] = [
      ["bearer token", "Bearer abc123"],
      ["payment but not a credential", "Payment not-base64-json"],
      ["empty", ""],
    ];
    for (const [name, value] of cases) {
      const headers = new Headers({ authorization: value });
      expect(credential(headers), `case: ${name}`).toBeUndefined();
    }
    expect(credential(new Headers()), "case: no header").toBeUndefined();
  });

  /**
   * A client whose charge always fails with `failure`, so a test can drive the
   * one call that both checks and settles without a chain behind it.
   */
  async function refusingClient(failure: unknown): Promise<Client> {
    const built = await clientOn(testConfig(), MODERATO);
    return {
      ...built,
      handler: {
        ...built.handler,
        broadcastCredential: () => Promise.reject(failure),
      } as Client["handler"],
    };
  }

  /**
   * Headers carrying a credential that answers the first challenge we advertise,
   * the first token offered, with a signed transaction.
   */
  async function payingHeaders(): Promise<Headers> {
    const built = await clientOn(testConfig(), MODERATO);
    const advertised = await challenge(built, WEB_SEARCH_PATH);
    const [first] = Challenge.deserializeList(advertised?.value as string);
    return answering(first as Challenge.Challenge);
  }

  it("mpp_unreachable_tempo_rpc_is_a_gateway_error", async () => {
    // The credential is good; only the endpoint is gone. That is our failure and
    // not the payer's, so it must not read as "you did not pay".
    const metrics = new Metrics();
    const unreachable = new HttpRequestError({ url: "http://tempo.invalid" });
    const response = await handle(
      await refusingClient(unreachable),
      undefined,
      metrics,
      WEB_SEARCH_PATH,
      await payingHeaders(),
      () => Promise.reject(new Error("the search must never run")),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "payment network unavailable" });
    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",outcome="network_unavailable"} 1`,
    );
    // Nobody answered, so this one is ours and not the payer's.
    await assertRecorded(
      metrics,
      'bx402_payment_failures_total{rail="mpp",step="charge",reason="unreachable"} 1',
    );
  });

  it("an_unreachable_tempo_rpc_records_the_charge_it_attempted", async () => {
    const metrics = new Metrics();
    await handle(
      await refusingClient(new HttpRequestError({ url: "http://tempo.invalid" })),
      undefined,
      metrics,
      WEB_SEARCH_PATH,
      await payingHeaders(),
      () => Promise.reject(new Error("the search must never run")),
    );

    // Timed even when it fails, so a dead endpoint shows up as attempted work
    // rather than as nothing at all.
    await assertRecorded(
      metrics,
      'bx402_payment_step_duration_seconds_count{rail="mpp",step="charge"} 1',
    );
  });

  it("a_claim_store_that_cannot_answer_is_a_gateway_error", async () => {
    // The SDK wraps what its store throws, so the failure arrives as a cause.
    const metrics = new Metrics();
    const wrapped = new Error("internal payment error", {
      cause: new ClaimStoreError(new Error("ServiceUnavailable")),
    });
    const response = await handle(
      await refusingClient(wrapped),
      undefined,
      metrics,
      WEB_SEARCH_PATH,
      await payingHeaders(),
      () => Promise.reject(new Error("the search must never run")),
    );

    expect(response.status).toBe(502);
    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",outcome="network_unavailable"} 1`,
    );
    await assertRecorded(
      metrics,
      'bx402_payment_failures_total{rail="mpp",step="claim",reason="unreachable"} 1',
    );
  });

  it("a_replayed_transaction_is_counted_as_a_duplicate", async () => {
    const metrics = new Metrics();
    const response = await handle(
      await refusingClient(
        new Errors.CredentialReplayedError({ reason: "Transaction hash has already been used" }),
      ),
      undefined,
      metrics,
      WEB_SEARCH_PATH,
      await payingHeaders(),
      () => Promise.reject(new Error("the search must never run")),
    );

    // Read by the client exactly like any other refusal.
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "mpp payment did not verify" });
    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",outcome="duplicate"} 1`,
    );
    await assertNotRecorded(metrics, "bx402_payment_failures_total{");
  });

  it("a_settled_transfer_bound_to_another_challenge_is_not_a_duplicate", async () => {
    // The SDK raises the replay error here too, but only after the transfer
    // settled, so it is a refusal with money moved and not a replay.
    const metrics = new Metrics();
    await handle(
      await refusingClient(
        new Errors.CredentialReplayedError({ reason: "memo is not bound to this challenge" }),
      ),
      undefined,
      metrics,
      WEB_SEARCH_PATH,
      await payingHeaders(),
      () => Promise.reject(new Error("the search must never run")),
    );

    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",outcome="refused"} 1`,
    );
  });

  it("a_refused_charge_is_not_a_gateway_error", async () => {
    // Anything that is not the endpoint being unreachable is the payer's
    // problem, and reads as a plain refusal.
    const metrics = new Metrics();
    const response = await handle(
      await refusingClient(new Error("Payment verification failed: amount mismatch")),
      undefined,
      metrics,
      WEB_SEARCH_PATH,
      await payingHeaders(),
      () => Promise.reject(new Error("the search must never run")),
    );

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "mpp payment did not verify" });
    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",outcome="refused"} 1`,
    );
    // Declined, and the rail was told nothing about why.
    await assertRecorded(
      metrics,
      'bx402_payment_failures_total{rail="mpp",step="charge",reason="unspecified"} 1',
    );
    await assertNotRecorded(metrics, 'outcome="network_unavailable"');
  });

  it("attached_receipt_parses_back_from_the_header", async () => {
    // The money has already moved by the time the search runs, so the receipt
    // rides back on whatever the search returned.
    const settled = Receipt.from({
      method: "tempo",
      reference: "0xtxhash",
      status: "success",
      timestamp: new Date().toISOString(),
    });
    const built = await clientOn(testConfig(), MODERATO);
    const charged: Client = {
      ...built,
      handler: {
        ...built.handler,
        broadcastCredential: () => Promise.resolve(settled),
      } as Client["handler"],
    };

    const response = await handle(
      charged,
      undefined,
      new Metrics(),
      WEB_SEARCH_PATH,
      await payingHeaders(),
      () => Promise.resolve(new Response("upstream body", { status: 200 })),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("upstream body");
    const parsed = Receipt.deserialize(response.headers.get("payment-receipt") as string);
    expect(parsed.status).toBe("success");
    expect(parsed.reference).toBe("0xtxhash");
  });

  it("a_settled_charge_is_recorded_at_the_catalog_price", async () => {
    const metrics = new Metrics();
    const built = await clientOn(testConfig(), MODERATO);
    const charged: Client = {
      ...built,
      handler: {
        ...built.handler,
        broadcastCredential: () =>
          Promise.resolve(
            Receipt.from({
              method: "tempo",
              reference: "0xtxhash",
              status: "success",
              timestamp: new Date().toISOString(),
            }),
          ),
      } as Client["handler"],
    };

    await handle(charged, undefined, metrics, WEB_SEARCH_PATH, await payingHeaders(), () =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",outcome="settled"} 1`,
    );
    // What we count as earned is what we advertised, never anything the payer
    // said, in the token the answered challenge named (the first one offered).
    await assertRecorded(
      metrics,
      `bx402_charged_base_units_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",asset="OUSD on Tempo Testnet (Moderato)"} 5000`,
    );
    // The payer the signature names, counted and not recorded.
    await assertRecorded(metrics, 'bx402_distinct_payers{rail="mpp"} 1');
  });

  it("a_real_charge_claims_its_transaction_and_releases_the_claim_when_the_broadcast_fails", async () => {
    // The SDK's own charge, not a stand in, so an SDK that starts reading or
    // writing the store, which the store answers as unreachable, fails here.
    const tempo = mockTempoRpc(MODERATO);
    const metrics = new Metrics();
    const { built, headers, calls } = await realCharge(metrics);
    // The SDK simulates the transfer once per check (it checks twice), claims
    // it, simulates once more, and broadcasts, which the endpoint refuses.
    tempoAnswers(undefined, undefined, undefined, "insufficient funds for gas");

    const response = await handle(built, undefined, metrics, WEB_SEARCH_PATH, headers, () =>
      Promise.reject(new Error("the search must never run")),
    );

    expect(response.status).toBe(402);
    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",outcome="refused"} 1`,
    );
    // Every answer used, so the refusal came from the broadcast itself.
    expect(tempo.pendingInterceptors()).toEqual([]);
    // Claimed under this rail before the broadcast and released after it
    // failed, so the payer can retry the same transaction.
    const [claimed] = calls;
    expect(claimed).toMatch(/^claim mpp:/);
    expect(calls).toEqual([claimed, claimed?.replace("claim", "release")]);
  });

  it("a_real_charge_whose_transaction_is_claimed_elsewhere_is_a_duplicate", async () => {
    // The first replica's claim, found by the second through the shared store.
    mockTempoRpc(MODERATO);
    const { built, headers, claims, calls } = await realCharge(new Metrics());
    tempoAnswers(undefined, undefined, undefined, "insufficient funds for gas");
    await handle(built, undefined, new Metrics(), WEB_SEARCH_PATH, headers, () =>
      Promise.reject(new Error("the search must never run")),
    );
    const key = calls[0]?.replace("claim ", "") as string;
    expect(await claims.tryClaim(key, Date.now() + 60_000)).toBeDefined();
    // Only the two transfer checks run before the claim. Anything past it
    // would find no answer and read as unreachable.
    tempoAnswers(undefined, undefined);
    const metrics = new Metrics();

    const response = await handle(built, undefined, metrics, WEB_SEARCH_PATH, headers, () =>
      Promise.reject(new Error("the search must never run")),
    );

    expect(response.status).toBe(402);
    await assertRecorded(
      metrics,
      `bx402_payments_total{rail="mpp",endpoint="${WEB_SEARCH_PATH}",outcome="duplicate"} 1`,
    );
  });

  it("the_sdk_store_claims_and_releases_keys_under_this_rail", async () => {
    const claims = new MemoryClaimStore();
    const metrics = new Metrics();
    const store = replayStore(claims, metrics);
    const later = Date.now() + 60_000;

    expect(await store.tryClaim?.("hash", later)).toBe(true);
    expect(await store.tryClaim?.("hash", later)).toBe(false);
    // Every claim is timed as its own step, apart from the charge around it.
    await assertRecorded(
      metrics,
      'bx402_payment_step_duration_seconds_count{rail="mpp",step="claim"} 2',
    );
    // Recorded under the rail's own prefix, so it cannot collide with x402.
    expect(await claims.tryClaim("mpp:hash", later)).toBeUndefined();

    await store.delete("hash");
    expect(await store.tryClaim?.("hash", later)).toBe(true);
  });

  it("the_sdk_store_removes_only_the_claim_it_took", async () => {
    const claims = new MemoryClaimStore();
    const store = replayStore(claims, new Metrics());
    const later = Date.now() + 60_000;
    expect(await store.tryClaim?.("hash", later)).toBe(true);
    await store.delete("hash");
    // Another replica takes the freed key, then the first removal repeats.
    const other = await claims.tryClaim("mpp:hash", later);
    await store.delete("hash");

    expect(other).toBeDefined();
    expect(await claims.tryClaim("mpp:hash", later)).toBeUndefined();
  });

  it("the_sdk_store_refuses_reads_and_writes_it_is_never_meant_to_get", async () => {
    // Only fee sponsorship reads and writes the store, and it is never set up.
    // Failing like an unreachable store turns any such call into a 502.
    const store = replayStore(new MemoryClaimStore(), new Metrics());
    await expect(store.get("key")).rejects.toBeInstanceOf(ClaimStoreError);
    await expect(store.put("key", 1)).rejects.toBeInstanceOf(ClaimStoreError);
    await expect(
      store.update("key", () => ({ op: "noop", result: undefined })),
    ).rejects.toBeInstanceOf(ClaimStoreError);
  });
});
