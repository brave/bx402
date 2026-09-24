import { generateKeyPairSync } from "node:crypto";
import { type FacilitatorClient, HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { extractDiscoveryInfo, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { afterEach, describe, expect, it } from "vitest";
import { ENDPOINTS, findEndpoint } from "../src/endpoints.js";
import { Metrics } from "../src/metrics.js";
import {
  accepts,
  challenge,
  client,
  decodePayment,
  handle,
  offers,
  PAYMENT_REQUIRED_HEADER,
  resourceServer,
} from "../src/x402.js";
import {
  decodeChallenge,
  mockOrigin,
  restoreNetwork,
  TEST_FACILITATOR,
  testClient,
} from "./support.js";

/** The offers advertised for one paid path. */
function offersFor(allowTestnet: boolean, path: string) {
  const offers = accepts(allowTestnet).get(path);
  if (offers === undefined) {
    throw new Error(`${path} is a paid endpoint`);
  }
  return offers;
}

/** Headers carrying `payload` as the base64 `PAYMENT-SIGNATURE`. */
function paymentHeaders(payload: unknown): Headers {
  return new Headers({
    "payment-signature": Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  });
}

/** A well-formed eip3009 authorization, the least a decodable payment carries. */
const AUTHORIZATION = {
  from: `0x${"AB".repeat(20)}`,
  nonce: `0x${"CD".repeat(32)}`,
};

/**
 * A CDP API key secret that really signs: 64 base64 bytes of Ed25519 seed plus
 * public key, the shape the CDP SDK detects and signs tokens with.
 */
function testCdpSecret(): string {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string };
  const pub = publicKey.export({ format: "jwk" }) as { x?: string };
  return Buffer.concat([
    Buffer.from(jwk.d ?? "", "base64url"),
    Buffer.from(pub.x ?? "", "base64url"),
  ]).toString("base64");
}

/** The base URL of the Coinbase-hosted facilitator. */
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

/**
 * The request a payment is made against in these tests, and what it is relayed as
 * having bought: the same URL without its query.
 */
const REQUESTED = "https://bx402.example.com/res/v1/web/search?q=rust";
const RELAYED_URL = "https://bx402.example.com/res/v1/web/search";
const RELAYED_DESCRIPTION = findEndpoint("/res/v1/web/search")?.description ?? "";

/** The resource a decoded payment carries, whatever the payer echoed. */
function relayedResource(decoded: { payload: PaymentPayload } | undefined):
  | {
      url?: string;
      description?: string;
      serviceName?: string;
      tags?: string[];
    }
  | undefined {
  if (decoded === undefined) {
    throw new Error("the payment decodes");
  }
  return (
    decoded.payload as {
      resource?: { url?: string; description?: string; serviceName?: string; tags?: string[] };
    }
  ).resource;
}

/** The extensions a decoded payment carries, whatever the payer echoed. */
function relayedExtensions(decoded: { payload: PaymentPayload } | undefined): {
  bazaar?: { info?: unknown; routeTemplate?: unknown };
  mppx?: unknown;
} {
  if (decoded === undefined) {
    throw new Error("the payment decodes");
  }
  return (
    (
      decoded.payload as {
        extensions?: { bazaar?: { info?: unknown; routeTemplate?: unknown }; mppx?: unknown };
      }
    ).extensions ?? {}
  );
}

/** The bazaar declaration the cold `402` advertises for `requested`. */
function declarationFor(requested: string): unknown {
  const entry = challenge(testClient(), requested, "GET");
  if (entry === undefined) {
    throw new Error(`${requested} is a paid endpoint`);
  }
  return (decodeChallenge(entry.value) as { extensions: { bazaar: unknown } }).extensions.bazaar;
}

/**
 * The most a cold `402` header may take. A client echoes the challenge's resource
 * and extensions back in `PAYMENT-SIGNATURE`, and common proxies refuse a request
 * header over 8 KB. The rest is left for the signature the client adds.
 */
const CHALLENGE_HEADER_LIMIT = 6 * 1024;

/** The body CDP sends with a settlement it sent to the chain but has not seen confirmed. */
const PENDING = {
  success: false,
  errorReason: "settlement_pending",
  transaction: "0xtxhash",
  network: "eip155:84532",
};

const SETTLED = { success: true, transaction: "0xtxhash", network: "eip155:84532" };

/**
 * Pay for a search against a facilitator that answers each `/settle` with the next
 * of `replies`, and return the response with the settle requests it received.
 */
async function payAgainst(replies: { statusCode: number; data: object }[]) {
  const pool = mockOrigin(TEST_FACILITATOR);
  pool.intercept({ method: "POST", path: "/verify" }).reply(200, { isValid: true });
  for (const reply of replies) {
    pool.intercept({ method: "POST", path: "/settle" }).reply(reply.statusCode, reply.data);
  }
  // The mock network hands the request body over as a stream, so each settle is
  // recorded as the SDK asks for it, then sent over HTTP by the real client.
  const http = new HTTPFacilitatorClient({ url: TEST_FACILITATOR });
  const settled: string[] = [];
  const built = testClient();
  built.server = resourceServer({
    verify: (payload, offer) => http.verify(payload, offer),
    settle: (payload, offer) => {
      settled.push(JSON.stringify([payload, offer]));
      return http.settle(payload, offer);
    },
    getSupported: () => http.getSupported(),
  });
  const response = await handle(
    built,
    undefined,
    new Metrics(),
    "/res/v1/web/search",
    REQUESTED,
    paymentHeaders({
      x402Version: 2,
      accepted: offersFor(true, "/res/v1/web/search")[0],
      payload: { authorization: AUTHORIZATION },
    }),
    async () => new Response(JSON.stringify({ web: {} }), { status: 200 }),
  );
  return { response, settled };
}

describe("x402", () => {
  afterEach(restoreNetwork);

  it("without_the_testnet_flag_only_mainnet_is_offered", () => {
    const entries = offersFor(false, "/res/v1/web/search");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.network).toBe("eip155:8453"); // Base mainnet
  });

  it("discovery_offers_restate_the_accepts_table", () => {
    const built = client({ facilitatorUrl: "https://x402.org/facilitator", cdp: undefined }, true);
    const entries = offersFor(true, "/res/v1/web/search");

    const stated = offers(built, "/res/v1/web/search");
    expect(stated).toHaveLength(entries.length);
    for (const [index, offer] of stated.entries()) {
      expect(offer.intent).toBe("charge");
      expect(offer.method).toBe("x402");
      expect(offer.amount).toBe(entries[index]?.amount);
      expect(offer.currency).toBe(entries[index]?.asset);
    }

    // The chain is named in words, testnet first like the cold 402, since the
    // offer object has no network field a reader could tell them apart by.
    expect(stated.map((offer) => offer.description)).toEqual([
      "USDC on Base Sepolia (testnet)",
      "USDC on Base",
    ]);
  });

  it("discovery_offers_are_empty_for_a_path_that_is_not_sold", () => {
    const built = client({ facilitatorUrl: "https://x402.org/facilitator", cdp: undefined }, true);
    expect(offers(built, "/res/v1/answers/search")).toEqual([]);
  });

  it("decode_reads_the_offer_the_payer_accepted", () => {
    const entries = offersFor(true, "/res/v1/web/search");

    const decoded = decodePayment(
      paymentHeaders({ accepted: entries[0], payload: { authorization: AUTHORIZATION } }),
      REQUESTED,
    );
    expect(decoded?.accepted).toEqual(entries[0]);
    expect(decoded?.payer).toBe(AUTHORIZATION.from.toLowerCase());

    // A payload naming no offer at all cannot be read.
    expect(
      decodePayment(paymentHeaders({ payload: { authorization: AUTHORIZATION } }), REQUESTED),
    ).toBe(undefined);
  });

  it("a_payment_without_a_full_authorization_cannot_be_read", () => {
    // Every offer we advertise is an eip3009 transfer, so a payload lacking a
    // plausible authorization is malformed for all of them. This includes a
    // nonce of the wrong size, which must never become a replay key.
    const entries = offersFor(true, "/res/v1/web/search");
    const decode = (payload: unknown) =>
      decodePayment(paymentHeaders({ accepted: entries[0], payload }), REQUESTED);

    expect(decode({})).toBeUndefined();
    expect(decode({ authorization: { from: AUTHORIZATION.from } })).toBeUndefined();
    expect(decode({ authorization: { nonce: AUTHORIZATION.nonce } })).toBeUndefined();
    expect(
      decode({ authorization: { from: AUTHORIZATION.from, nonce: `0x${"cd".repeat(4096)}` } }),
    ).toBeUndefined();
  });

  it("the_claim_key_is_the_nonce_scoped_by_the_payer", () => {
    const entries = offersFor(true, "/res/v1/web/search");

    // The same payment under two encodings: key order differs, so the header
    // bytes differ, but both name one authorization.
    const first = decodePayment(
      paymentHeaders({ accepted: entries[0], payload: { authorization: AUTHORIZATION } }),
      REQUESTED,
    );
    const second = decodePayment(
      paymentHeaders({ payload: { authorization: AUTHORIZATION }, accepted: entries[0] }),
      REQUESTED,
    );

    expect(first?.claim.key).toBe(
      `${AUTHORIZATION.from.toLowerCase()}:${AUTHORIZATION.nonce.toLowerCase()}`,
    );
    expect(second?.claim.key).toBe(first?.claim.key);
  });

  it("the_claim_window_is_the_offer_timeout_not_the_clients_deadline", () => {
    // A sender must not shorten how long its payment is held against
    // duplicates, so a deadline just ahead does not move the expiry.
    const entries = offersFor(true, "/res/v1/web/search");
    const validBefore = String(Math.floor(Date.now() / 1000) + 3);
    const decoded = decodePayment(
      paymentHeaders({
        accepted: entries[0],
        payload: { authorization: { ...AUTHORIZATION, validBefore } },
      }),
      REQUESTED,
    );

    const window = (entries[0]?.maxTimeoutSeconds ?? 0) * 1000;
    expect(decoded?.claim.expires).toBeGreaterThan(Date.now() + window - 5_000);
    expect(decoded?.claim.expires).toBeLessThanOrEqual(Date.now() + window);
  });

  it("decode_relays_the_resource_this_service_served_not_the_payers_claim", () => {
    // A catalog records a settled payment against the resource the payload names,
    // and the payer does not get to choose that.
    const entries = offersFor(true, "/res/v1/web/search");
    const resource = relayedResource(
      decodePayment(
        paymentHeaders({
          x402Version: 2,
          resource: {
            url: "https://attacker.example/anything?q=private",
            description: "Cheap searches, pay attacker",
            serviceName: "Not Brave",
            tags: ["spam"],
          },
          accepted: entries[0],
          payload: { authorization: AUTHORIZATION },
        }),
        REQUESTED,
      ),
    );

    expect(resource?.url).toBe(RELAYED_URL);
    expect(resource?.description).toBe(RELAYED_DESCRIPTION);
    expect(resource?.serviceName).toBe("Brave Search");
    expect(resource?.tags).toEqual(["search", "web", "news", "images", "llm"]);
  });

  it("decode_states_the_resource_even_when_the_payer_echoed_none", () => {
    // The resource is our own account of the request, so the listing does not
    // depend on the payer having echoed one.
    const entries = offersFor(true, "/res/v1/web/search");
    const resource = relayedResource(
      decodePayment(
        paymentHeaders({ accepted: entries[0], payload: { authorization: AUTHORIZATION } }),
        REQUESTED,
      ),
    );

    expect(resource?.url).toBe(RELAYED_URL);
    expect(resource?.description).toBe(RELAYED_DESCRIPTION);
  });

  it("decode_relays_no_resource_for_a_request_it_cannot_name", () => {
    // A facilitator tolerates a payment naming no resource, but an empty or
    // unparseable URL breaks it, so resource and declaration both drop.
    const entries = offersFor(true, "/res/v1/web/search");
    const decodeFor = (requested: string) =>
      decodePayment(
        paymentHeaders({
          x402Version: 2,
          resource: { url: "https://bx402.example.com/res/v1/web/search?q=private" },
          extensions: { bazaar: { info: {}, schema: {} } },
          accepted: entries[0],
          payload: { authorization: AUTHORIZATION },
        }),
        requested,
      );

    for (const requested of [
      "/res/v1/web/search?q=rust",
      "not a url at all",
      "file:///res/v1/web/search?q=rust",
      "http://bx402.example.com/res/v1/web/search?q=rust",
      "https://bx402.example.com/res/v1/nothing/we/sell",
    ]) {
      const decoded = decodeFor(requested);
      expect(relayedResource(decoded), requested).toBeUndefined();
      expect(relayedExtensions(decoded).bazaar, requested).toBeUndefined();
      expect(decoded?.accepted).toEqual(entries[0]);
    }
  });

  it("decode_restates_the_declaration_the_payer_echoed", () => {
    // A payer's `routeTemplate` would steer the listing away from the path it paid
    // for, so ours goes out whatever arrived.
    const entries = offersFor(true, "/res/v1/web/search");
    const decoded = decodePayment(
      paymentHeaders({
        x402Version: 2,
        accepted: entries[0],
        extensions: {
          bazaar: { info: {}, schema: {}, routeTemplate: "/anything" },
          mppx: { info: { method: "GET" }, schema: { type: "object" } },
        },
        payload: { authorization: AUTHORIZATION },
      }),
      REQUESTED,
    );

    const extensions = relayedExtensions(decoded);
    expect(extensions.bazaar?.routeTemplate).toBeUndefined();
    expect(extensions.bazaar).toEqual(declarationFor(REQUESTED));
    // Anything else the payer echoed rides along, since its own reader checks it.
    expect(extensions.mppx).toEqual({ info: { method: "GET" }, schema: { type: "object" } });
  });

  it("the_verify_call_carries_the_resource_this_service_served", async () => {
    // A real client echoes the challenge's resource back, query string
    // included. The rail relays the decoded payload to the facilitator, so a
    // recording stand-in reads exactly what the SDK would serialize.
    const entries = offersFor(true, "/res/v1/web/search");
    const forwardedFor = async (query: string) => {
      const built = testClient();
      let forwarded: { resource?: { url?: string }; accepted?: unknown } | undefined;
      built.server = resourceServer({
        verify: async (payload: PaymentPayload) => {
          forwarded = payload as { resource?: { url?: string }; accepted?: unknown };
          return { isValid: true };
        },
        settle: async () => ({
          success: true,
          transaction: "0xtxhash",
          network: "eip155:84532",
        }),
      } as unknown as FacilitatorClient);
      const requested = `https://bx402.example.com/res/v1/web/search?q=${query}`;
      const response = await handle(
        built,
        undefined,
        new Metrics(),
        "/res/v1/web/search",
        requested,
        paymentHeaders({
          x402Version: 2,
          resource: { url: requested, description: "Brave Search API - Web / Search" },
          accepted: entries[0],
          payload: { authorization: AUTHORIZATION },
        }),
        async () => new Response(JSON.stringify({ web: {} }), { status: 200 }),
      );
      expect(response.status).toBe(200);
      return forwarded;
    };

    const forwarded = await forwardedFor("private");
    // The path and the offer the payer accepted arrive; the query does not.
    expect(forwarded?.resource?.url).toBe(RELAYED_URL);
    expect(forwarded?.accepted).toEqual(entries[0]);
    // Compared over the whole payload, not just the field the query came from, so
    // a search term cannot reach the facilitator riding in some other field.
    expect(await forwardedFor("something-else")).toEqual(forwarded);
  });

  it("a_tampered_offer_matches_nothing_we_advertise", () => {
    // Here the payer grants itself a discount. The payload still decodes, so it
    // is the value comparison in `handle` that refuses it.
    const entries = offersFor(true, "/res/v1/web/search");
    const discounted = { ...entries[0], amount: "1" };

    const decoded = decodePayment(
      paymentHeaders({ accepted: discounted, payload: { authorization: AUTHORIZATION } }),
      REQUESTED,
    );
    expect(decoded).toBeDefined();
    expect(entries).not.toContainEqual(decoded?.accepted);
  });

  it("cdp_credentials_pair_only_with_the_cdp_facilitator", () => {
    // A signed CDP token sent to any other host could be replayed against CDP
    // while it lives, so that combination must never build.
    const cdp = { apiKeyId: "key-id", apiKeySecret: "key-secret" };
    expect(() => client({ facilitatorUrl: "https://x402.org/facilitator", cdp }, true)).toThrow(
      /api\.cdp\.coinbase\.com/,
    );
    expect(client({ facilitatorUrl: CDP_FACILITATOR_URL, cdp }, true)).toBeDefined();
  });

  it("cdp_credentials_sign_the_verify_call", async () => {
    const built = client(
      {
        facilitatorUrl: CDP_FACILITATOR_URL,
        cdp: { apiKeyId: "key-id", apiKeySecret: testCdpSecret() },
      },
      true,
    );

    let authorization: string | null = null;
    mockOrigin("https://api.cdp.coinbase.com")
      .intercept({ method: "POST", path: "/platform/v2/x402/verify" })
      .reply((request) => {
        authorization = new Headers(request.headers as Record<string, string>).get("authorization");
        return { statusCode: 200, data: { isValid: true } };
      });

    const offer = offersFor(true, "/res/v1/web/search")[0];
    if (offer === undefined) {
      throw new Error("the paid path offers nothing");
    }
    const result = await built.server.verifyPayment({} as PaymentPayload, offer);
    expect(result.isValid).toBe(true);
    // The token itself is the CDP SDK's business; what is ours is that the
    // request went out bearing one.
    expect(authorization).toMatch(/^Bearer .+/);
  });

  it("challenge_emits_the_full_payment_required_payload", () => {
    // Every offer field is spelled out so a change to the SDK's defaults fails
    // here instead of silently moving the charge.
    const built = testClient();
    const entry = challenge(built, "https://bx402.example.com/res/v1/web/search?q=rust", "GET");
    expect(entry).toBeDefined();
    const { name, value } = entry as { name: string; value: string };
    expect(name).toBe(PAYMENT_REQUIRED_HEADER);

    expect(decodeChallenge(value)).toEqual({
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: "https://bx402.example.com/res/v1/web/search?q=rust",
        description: RELAYED_DESCRIPTION,
        mimeType: "application/json",
        serviceName: "Brave Search",
        tags: ["search", "web", "news", "images", "llm"],
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "5000",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0xbd9420A98a7Bd6B89765e5715e169481602D9c3d",
          maxTimeoutSeconds: 300,
          extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
        },
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "5000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0xbd9420A98a7Bd6B89765e5715e169481602D9c3d",
          maxTimeoutSeconds: 300,
          extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
        },
      ],
      extensions: {
        mppx: {
          info: { method: "GET" },
          schema: { type: "object" },
        },
        // Checked field by field in the tests that follow.
        bazaar: expect.any(Object),
      },
    });
  });

  it("the_catalog_metadata_stays_inside_what_a_facilitator_keeps", () => {
    // The payload schema rejects the whole resource over an overlong name or tag,
    // so an edit that overruns one would cost the payment, not just the listing.
    const built = testClient();
    const entry = challenge(built, "https://bx402.example.com/res/v1/web/search?q=rust", "GET");
    const { resource } = decodeChallenge((entry as { value: string }).value) as {
      resource: { serviceName: string; tags: string[] };
    };

    const printableAscii = /^[\x20-\x7e]+$/;
    expect(resource.serviceName.length).toBeLessThanOrEqual(32);
    expect(resource.serviceName).toMatch(printableAscii);
    expect(resource.tags.length).toBeLessThanOrEqual(5);
    for (const tag of resource.tags) {
      expect(tag.length).toBeLessThanOrEqual(32);
      expect(tag).toMatch(printableAscii);
    }
    // Compared case-insensitively, because a facilitator keeps the first of
    // two tags that differ only in case and drops the second.
    const lowercased = resource.tags.map((tag) => tag.toLowerCase());
    expect(new Set(lowercased).size).toBe(resource.tags.length);
  });

  it("every_description_stays_inside_what_a_facilitator_accepts", () => {
    // The CDP facilitator refuses to verify or settle a payment whose resource
    // description runs over 500 characters.
    for (const { path, description } of ENDPOINTS) {
      expect(description.length, path).toBeGreaterThan(0);
      expect(description.length, path).toBeLessThanOrEqual(500);
    }
  });

  it("the_declaration_describes_the_get_call_even_for_a_head_request", () => {
    // HEAD is a paid method too, but it returns no body, and the catalog entry has
    // to name the call that returns what is being bought.
    const built = testClient();
    const entry = challenge(built, "https://bx402.example.com/res/v1/web/search?q=rust", "HEAD");
    const { extensions } = decodeChallenge((entry as { value: string }).value) as {
      extensions: {
        mppx: { info: { method: string } };
        bazaar: { info: { input: { method: string } } };
      };
    };

    // The mppx binding still reflects the request, because it is what the
    // client signs over.
    expect(extensions.mppx.info.method).toBe("HEAD");
    expect(extensions.bazaar.info.input.method).toBe("GET");
  });

  it("every_declaration_is_one_a_facilitator_accepts", () => {
    // A facilitator refuses a declaration whose call does not satisfy its own
    // schema, and settles the payment without listing it. These are the checks the
    // x402 reference package runs.
    for (const { path } of ENDPOINTS) {
      const requested = `https://bx402.example.com${path}?q=rust`;
      const declaration = declarationFor(requested);
      expect(validateDiscoveryExtension(declaration as never), path).toEqual({ valid: true });

      const decoded = decodePayment(
        paymentHeaders({
          x402Version: 2,
          accepted: offersFor(true, path)[0],
          payload: { authorization: AUTHORIZATION },
        }),
        requested,
      );
      if (decoded === undefined) {
        throw new Error("the payment decodes");
      }
      const listed = extractDiscoveryInfo(decoded.payload, decoded.accepted);
      expect(listed?.resourceUrl, path).toBe(`https://bx402.example.com${path}`);
      expect(listed?.discoveryInfo, path).toEqual((declaration as { info: unknown }).info);
    }
  });

  it("every_challenge_fits_in_one_request_header", () => {
    // Measured with the longest query Brave accepts, since the challenge names
    // the URL it was served for.
    const longest = "q".repeat(600);
    for (const { path } of ENDPOINTS) {
      const entry = challenge(testClient(), `https://bx402.example.com${path}?q=${longest}`, "GET");
      expect(entry?.value.length, path).toBeLessThanOrEqual(CHALLENGE_HEADER_LIMIT);
    }
  });

  it("a_pending_settlement_is_asked_about_once_more", async () => {
    // CDP answers a payment it sent but has not seen confirmed with a 500. The
    // same request again makes it check that transaction rather than send another.
    const { response, settled } = await payAgainst([
      { statusCode: 500, data: PENDING },
      { statusCode: 200, data: SETTLED },
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.has("payment-response")).toBe(true);
    expect(settled).toHaveLength(2);
    expect(settled[0]).toContain(AUTHORIZATION.nonce);
    expect(settled[1]).toBe(settled[0]);
  });
});
