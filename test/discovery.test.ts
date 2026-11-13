import { readFileSync } from "node:fs";
import type { SupportedResponse } from "@x402/core/types";
import { validate } from "mppx/discovery";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import {
  type DiscoveryDocument,
  document,
  GUIDE_PATH,
  type GuideFacts,
  guideFacts,
  renderGuide,
} from "../src/discovery.js";
import { ENDPOINTS } from "../src/endpoints.js";
import { VERSION } from "../src/version.js";
import { accepts } from "../src/x402.js";
import {
  buildContext,
  MAINNET_SUPPORT,
  restoreNetwork,
  TEST_CHAIN_ID,
  testConfig,
  WEB_SEARCH_PATH,
} from "./support.js";

/** Tempo mainnet, for the deployment rows that settle on mainnet alone. */
const MAINNET = 4217;

/**
 * The document a deployment with `overrides` serves, its MPP endpoint canned
 * to report `chain` and its facilitator to support `support`. The build itself
 * is the production path.
 */
async function documentFor(
  overrides: Partial<Config> = {},
  chain = TEST_CHAIN_ID,
  support?: SupportedResponse,
): Promise<DiscoveryDocument> {
  return document(await buildContext(testConfig(overrides), chain, support));
}

/** The offers stated for one path. */
function offersOf(doc: DiscoveryDocument, path: string) {
  return doc.paths[path]?.get["x-payment-info"]?.offers ?? [];
}

describe("discovery", () => {
  afterEach(restoreNetwork);

  it("the_document_passes_the_spec_validator", async () => {
    interface Deployment {
      /** Label printed if the assertion fails. */
      name: string;
      overrides: Partial<Config>;
      chain?: number;
      support?: SupportedResponse;
    }
    const deployments: Deployment[] = [
      { name: "both rails with the testnet", overrides: {} },
      { name: "both rails mainnet only", overrides: {}, chain: MAINNET, support: MAINNET_SUPPORT },
      { name: "x402 only", overrides: { mpp: undefined } },
      { name: "mpp only", overrides: { x402: undefined } },
      { name: "no rails", overrides: { x402: undefined, mpp: undefined } },
    ];
    for (const { name, overrides, chain, support } of deployments) {
      const doc = await documentFor(overrides, chain, support);
      // Empty rather than "no errors": the only warning the validator emits
      // is for a write method without a request body, and the document
      // publishes GET alone, so a warning is a signal too.
      expect(validate(doc), `case: ${name}`).toEqual([]);
    }
  });

  it("every_offer_carries_only_the_fields_the_spec_defines", async () => {
    const doc = await documentFor();
    const offers = Object.values(doc.paths).flatMap(
      (path) => path.get["x-payment-info"]?.offers ?? [],
    );
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      // The standing guard that the treasury address and the network id never
      // leak into the document. The spec validator is loose and accepts
      // unknown fields, so it would not catch either.
      expect(Object.keys(offer).sort()).toEqual(
        ["amount", "currency", "description", "intent", "method"].sort(),
      );
    }
  });

  it("every_paid_path_is_listed_with_a_402_and_its_price", async () => {
    const doc = await documentFor();
    for (const endpoint of ENDPOINTS) {
      const operation = doc.paths[endpoint.path]?.get;
      expect(operation, endpoint.path).toBeDefined();
      expect(operation?.responses["402"], endpoint.path).toBeDefined();
      const offers = offersOf(doc, endpoint.path);
      expect(offers.length, endpoint.path).toBeGreaterThan(0);
      for (const offer of offers) {
        expect(offer.amount, endpoint.path).toBe(String(endpoint.priceBaseUnits));
      }
    }
  });

  it("the_amount_is_in_base_units_not_the_decimal_charge", async () => {
    const doc = await documentFor();
    // The MPP charge behind the web search offers reads "0.005": a document
    // restating that would advertise a millionth of the price.
    // Two x402 offers and one MPP offer per accepted token.
    expect(offersOf(doc, WEB_SEARCH_PATH).map((offer) => offer.amount)).toEqual(
      Array(5).fill("5000"),
    );
  });

  it("the_document_states_the_required_top_level_fields", async () => {
    const doc = await documentFor();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Brave Search API");
    expect(doc.info.version).toBe(VERSION);
    expect(Object.keys(doc.paths)).toHaveLength(ENDPOINTS.length);
    // Relative, so a reader resolves it against wherever the document was
    // fetched from, an origin the service itself never learns.
    expect(doc["x-service-info"].docs.llms).toBe(GUIDE_PATH);
  });

  it("every_paid_path_states_its_dollar_price", async () => {
    const doc = await documentFor();
    for (const endpoint of ENDPOINTS) {
      // Every path sells at Brave's search rate, $5 per 1,000 requests, stated
      // in decimal dollars unlike the offers' base units.
      const price = doc.paths[endpoint.path]?.get["x-payment-info"]?.price;
      expect(price, endpoint.path).toEqual({ mode: "fixed", currency: "USD", amount: "0.005" });
    }
  });

  it("the_protocols_name_exactly_the_enabled_rails", async () => {
    const protocolsOf = async (overrides: Partial<Config>) =>
      (await documentFor(overrides)).paths[WEB_SEARCH_PATH]?.get["x-payment-info"]?.protocols;
    const mppProtocol = { mpp: { method: "tempo", intent: "charge", currency: "USD" } };
    expect(await protocolsOf({})).toEqual([{ x402: {} }, mppProtocol]);
    expect(await protocolsOf({ mpp: undefined })).toEqual([{ x402: {} }]);
    expect(await protocolsOf({ x402: undefined })).toEqual([mppProtocol]);
  });

  it("every_paid_path_states_its_query_parameters_and_response", async () => {
    const doc = await documentFor();
    for (const endpoint of ENDPOINTS) {
      const operation = doc.paths[endpoint.path]?.get;
      // x402scan refuses a paid path without an input and an output schema.
      expect(operation?.parameters.length, endpoint.path).toBeGreaterThan(0);
      for (const parameter of operation?.parameters ?? []) {
        expect(parameter.in, `${endpoint.path} ${parameter.name}`).toBe("query");
      }
      const json = operation?.responses["200"]?.content?.["application/json"];
      expect(json?.schema, endpoint.path).toMatchObject({ type: "object" });
      expect(json?.example, endpoint.path).toEqual(endpoint.call.response);
    }

    const parameter = (path: string, name: string) =>
      doc.paths[path]?.get.parameters.find((stated) => stated.name === name);
    expect(parameter(WEB_SEARCH_PATH, "q")).toEqual({
      name: "q",
      in: "query",
      required: true,
      description: "Search query",
      schema: { type: "string", maxLength: 600 },
    });
    expect(parameter(WEB_SEARCH_PATH, "count")).toMatchObject({ required: false });
    // Repeated as ids=a&ids=b, which is OpenAPI's default for a query array.
    expect(parameter("/res/v1/local/pois", "ids")).toMatchObject({
      required: true,
      description: expect.stringContaining("Repeat as ids=a&ids=b"),
      schema: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
    });
    // Place search takes q or a location, so no single parameter is required.
    const place = doc.paths["/res/v1/local/place_search"]?.get.parameters ?? [];
    expect(place.filter((stated) => stated.required)).toEqual([]);

    const web = doc.paths[WEB_SEARCH_PATH]?.get.responses["200"]?.content?.["application/json"];
    expect(web?.schema).toMatchObject({
      type: "object",
      properties: { web: { type: "object", properties: { results: { type: "array" } } } },
    });
  });

  it("a_disabled_rail_is_not_advertised", async () => {
    const x402Only = await documentFor({ mpp: undefined });
    expect(offersOf(x402Only, WEB_SEARCH_PATH).map((offer) => offer.method)).toEqual([
      "x402",
      "x402",
    ]);

    const mppOnly = await documentFor({ x402: undefined });
    expect(offersOf(mppOnly, WEB_SEARCH_PATH).map((offer) => offer.method)).toEqual(
      Array(3).fill("tempo"),
    );

    // With no rails nothing is advertised that cannot be paid: the extension
    // is absent, never an empty list, while the 402 stays declared.
    const none = await documentFor({ x402: undefined, mpp: undefined });
    const operation = none.paths[WEB_SEARCH_PATH]?.get;
    expect(operation?.["x-payment-info"]).toBeUndefined();
    expect(operation?.responses["402"]).toBeDefined();
  });

  it("the_testnet_offer_leads_like_the_cold_402", async () => {
    const doc = await documentFor();
    const stated = offersOf(doc, WEB_SEARCH_PATH)
      .filter((offer) => offer.method === "x402")
      .map((offer) => offer.currency);
    // Asserted against `accepts` rather than pasted addresses, which are
    // already pinned once in the x402 tests.
    const advertised = (accepts().get(WEB_SEARCH_PATH) ?? []).map((entry) => entry.asset);
    expect(advertised).toHaveLength(2);
    expect(stated).toEqual(advertised);
  });

  it("every_offer_describes_its_chain", async () => {
    const doc = await documentFor();
    for (const endpoint of ENDPOINTS) {
      const descriptions = offersOf(doc, endpoint.path).map((offer) => offer.description);
      for (const description of descriptions) {
        expect(description, endpoint.path).not.toBe("");
      }
      // Three offers, three distinct sentences. Offers identical but for an
      // unlabelled contract address are what made Parallel's document
      // unreadable.
      expect(new Set(descriptions).size, endpoint.path).toBe(descriptions.length);
    }

    // The canned deployment settles on moderato, and the document must say
    // so rather than read as mainnet.
    const tempo = offersOf(doc, WEB_SEARCH_PATH).find((offer) => offer.method === "tempo");
    expect(tempo?.description).toContain("Moderato");
  });

  it("the_guide_facts_come_from_the_started_rails", async () => {
    // Each rail serves what its startup call reports: x402 the networks its
    // facilitator supports, MPP the chain its endpoint names.
    const facts = async (overrides: Partial<Config>, chain: number, support?: SupportedResponse) =>
      guideFacts(await buildContext(testConfig(overrides), chain, support));

    expect(await facts({}, TEST_CHAIN_ID)).toEqual({
      testnet: true,
      mpp: true,
      mpptestnet: true,
    });
    expect(await facts({}, MAINNET)).toEqual({ testnet: true, mpp: true, mpptestnet: false });
    expect(await facts({ mpp: undefined }, MAINNET, MAINNET_SUPPORT)).toEqual({
      testnet: false,
      mpp: false,
      mpptestnet: false,
    });
  });

  it("the_guide_keeps_only_the_sections_true_of_the_deployment", () => {
    const facts: GuideFacts = { testnet: false, mpp: false, mpptestnet: false };
    const template = [
      "always, {price}",
      "{if testnet}",
      "testnet only",
      "{end}",
      "{if !testnet}",
      "mainnet only",
      "{if mpp}",
      "never, nested inside a kept section",
      "{end}",
      "{end}",
      "",
      "{if mpp}",
      "",
      "dropped with its blank line",
      "{end}",
      "",
      "{prices}",
    ].join("\n");

    const rows = ENDPOINTS.map(
      (endpoint) =>
        `| \`${endpoint.path}\` | ${endpoint.priceBaseUnits} | $${endpoint.priceBaseUnits / 1000}/1k |`,
    );
    expect(renderGuide(template, facts)).toBe(
      ["always, 5000", "mainnet only", "", ...rows].join("\n"),
    );
  });

  it("a_guide_the_renderer_cannot_read_refuses_startup", () => {
    const facts: GuideFacts = { testnet: false, mpp: false, mpptestnet: false };
    expect(() => renderGuide("{if nonsense}\n{end}", facts)).toThrow(/unknown section/);
    expect(() => renderGuide("{end}", facts)).toThrow(/without a matching/);
    expect(() => renderGuide("{if mpp}", facts)).toThrow(/never closed/);
  });

  it("the_shipped_guide_says_only_what_each_deployment_does", () => {
    // Every combination of facts, rendered from the file the service serves, so
    // an edit that leaves testnet or MPP wording where it does not apply fails.
    const template = readFileSync(new URL("../llms.txt", import.meta.url), "utf8");
    for (const testnet of [false, true]) {
      for (const mpp of [false, true]) {
        for (const mpptestnet of [false, true]) {
          const facts = { testnet, mpp, mpptestnet: mpp && mpptestnet };
          const label = JSON.stringify(facts);
          const guide = renderGuide(template, facts);

          expect(guide, label).not.toMatch(/\{if |\{end\}|\{prices?\}|\n\n\n/);
          expect(guide, label).toContain(
            "purl --max-amount 5000 '{origin}/res/v1/web/search?q=rust'",
          );
          expect(guide, label).toContain("| `/res/v1/local/descriptions` | 5000 | $5/1k |");
          if (!facts.testnet && !facts.mpptestnet) {
            expect(guide, label).not.toMatch(/sepolia|testnet|moderato/i);
          }
          if (!mpp) {
            expect(guide, label).not.toMatch(/\bmpp\b|pathusd|\btempo\b/i);
          } else {
            expect(guide, label).toContain("Both rails charge the same price");
          }
          expect(guide.includes("Base Sepolia"), label).toBe(testnet);
          expect(guide.includes("npx mppx --network testnet"), label).toBe(facts.mpptestnet);
        }
      }
    }
  });
});
