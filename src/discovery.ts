/**
 * Service discovery: the machine-readable description of what this service
 * sells and how to pay for it.
 *
 * The shapes here follow MPP's payment discovery draft and x402scan's discovery
 * profile (https://x402scan.com/discovery/spec), which agree on where the
 * document lives: a discovery-aware client fetches `/openapi.json` and looks
 * nowhere else. The document links a buyer's guide in prose at `/llms.txt`.
 * Discovery is advisory; the runtime `402` challenge stays authoritative for
 * what a request must pay.
 *
 * This module is protocol-neutral: it names no rail's header, asset, or
 * chain. See `x402.ts` and `mpp.ts` for what each rail advertises.
 */

import { readFileSync } from "node:fs";
import { type Param, schemaOf } from "./calls.js";
import type { Context } from "./dispatch.js";
import { ENDPOINTS, type Endpoint, priceDollars } from "./endpoints.js";
import { AppError, describe } from "./error.js";
import * as mpp from "./mpp.js";
import { VERSION } from "./version.js";
import * as x402 from "./x402.js";

/** Where the discovery document is served. The spec fixes this exact path. */
export const DISCOVERY_PATH = "/openapi.json";

/** Where the buyer's guide is served, the path the document names under `docs.llms`. */
export const GUIDE_PATH = "/llms.txt";

/**
 * Cache lifetime for the discovery responses: the spec's recommended five
 * minutes for a service whose capabilities change infrequently. `public`
 * because the bodies are identical for every caller.
 */
export const CACHE_CONTROL = "public, max-age=300";

/**
 * One payment offer, as the spec's offer object defines it: exactly these
 * five fields and no others. In particular there is no recipient and no
 * network field, so the chain and token are named in `description`, the one
 * spec-defined place to state them in words.
 */
export interface Offer {
  /** What the payment buys. Every offer here charges for one request. */
  intent: "charge";
  /** The payment method identifier the matching challenge carries. */
  method: string;
  /** Price in base units of `currency`, as a decimal integer string. */
  amount: string;
  /** Address of the token the price is stated in. */
  currency: string;
  /** The token and chain in words, since no field states them. */
  description: string;
}

/**
 * One payment protocol a path accepts, keyed by the protocol's name, as
 * x402scan's discovery profile defines it. Each rail states its own.
 */
export type Protocol = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * The price of one request, in dollars. Every operation charges a fixed price,
 * and the decimal amount sits beside the offers' base units so a reader can
 * budget without knowing a token's decimals.
 */
interface Price {
  mode: "fixed";
  currency: "USD";
  /** Decimal dollars, such as "0.005". */
  amount: string;
}

/**
 * Short guidance for an agent reading the document, as x402scan's profile asks
 * under `info.x-guidance`: which call to make for what, named by operation id,
 * how to pay, and where the full guide is. An agent gets it whole before its
 * first call, so it stays short. It names only the protocols the deployment's
 * rails take; `x-payment-info` and the `402` name the exact tokens and chains.
 */
function agentGuidance(ctx: Context): string {
  const protocols = [
    ...(ctx.x402 === undefined ? [] : [x402.NAME]),
    ...(ctx.mpp === undefined ? [] : [mpp.NAME]),
  ];
  return [
    "Call llmContext to ground an answer: it returns the most relevant passages from the top " +
      "results, grouped by source URL; size it with maximum_number_of_tokens.",
    "Call webSearch for ranked links and snippets, and newsSearch, imagesSearch, or " +
      "videosSearch for those result types.",
    "For places, call localPlaceSearch, then pass its location ids to localPois for details " +
      "or localDescriptions for a summary.",
    // With no rail on nothing can be paid, so the guidance names no protocol.
    protocols.length === 0
      ? "Every call is a GET with query parameters."
      : "Every call is a GET with query parameters; an unpaid request returns a 402, so pay " +
        `it with ${protocols.join(" or ")} and retry the same request.`,
    `Read ${GUIDE_PATH} for the full guide.`,
  ].join(" ");
}

/**
 * One line on what the API sells. x402scan shows it beside the title in its
 * listing, since the origin serves no home page to take one from.
 */
const DESCRIPTION =
  "Brave Search over its own independent web index, with real-time search data your " +
  "chatbots & agents need to generate answers. Complete search results (URLs, text, news, " +
  "images, and more), plus additional LLM context optimized for AI. No account or API key: " +
  "each request is paid with a stablecoin micropayment.";

/**
 * Who answers for the service. x402scan reads it to confirm who owns the
 * origin, and a buyer can write to it about outages or prices.
 */
const CONTACT_EMAIL = "searchapi-support@brave.com";

/** Where the project documents itself for a human reader. */
const HOMEPAGE = "https://github.com/brave/bx402";

/**
 * Brave's reference for what each paid path accepts and returns. Query
 * parameters are forwarded unchanged, so Brave's reference is this API's.
 */
const API_REFERENCE = "https://api-dashboard.search.brave.com/documentation";

/** One query parameter of a paid path, in OpenAPI's parameter shape. */
interface Parameter {
  name: string;
  in: "query";
  required: boolean;
  /** What the parameter means, where readers that list parameters show it. */
  description?: string;
  schema: Param;
}

/** One response an operation declares, with its JSON shape when known. */
interface ResponseObject {
  description: string;
  content?: Record<string, { schema: Record<string, unknown>; example: unknown }>;
}

/**
 * How a path is paid for. `offers` is MPP's payment discovery shape; `price`
 * and `protocols` are x402scan's. Readers of either ignore the other's fields.
 */
interface PaymentInfo {
  price: Price;
  protocols: Protocol[];
  offers: Offer[];
}

/** One paid path's `get` operation, as far as the document states it. */
interface Operation {
  /** A name for the call, which tools that read the document turn into a function name. */
  operationId: string;
  /** The kind of search, so a reader can group the paths. */
  tags: string[];
  summary: string;
  parameters: Parameter[];
  /**
   * Absent rather than empty when no rail is enabled: the extension requires
   * at least one offer, and a document must not advertise what cannot be
   * paid. The `402` declaration below stays either way.
   */
  "x-payment-info"?: PaymentInfo;
  responses: Record<string, ResponseObject>;
}

/** The discovery document's shape, as far as this service states it. */
export interface DiscoveryDocument {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
    "x-guidance": string;
    contact: { email: string };
  };
  "x-service-info": {
    categories: string[];
    docs: { homepage: string; apiReference: string; llms: string };
  };
  paths: Record<string, { get: Operation }>;
}

/**
 * The discovery document: the spec's OpenAPI shape naming every paid path
 * and the offers the deployment's rails advertise for it.
 *
 * Composed from the same rail state the paid routes dispatch on, so the
 * document cannot drift from what a request is actually charged. It stays
 * advisory all the same: the runtime `402` challenge is authoritative, which
 * is why every operation declares that response.
 *
 * There is no `servers` block. No origin is configured, and a JSON reader can
 * resolve paths against wherever it fetched the document from.
 */
export function document(ctx: Context): DiscoveryDocument {
  const paths = Object.fromEntries(
    ENDPOINTS.map((endpoint) => [endpoint.path, { get: operation(ctx, endpoint) }]),
  );
  return {
    openapi: "3.1.0",
    // The build version stands in for the API version, so a release bumps
    // the document even when the paid surface is unchanged.
    info: {
      title: "Brave Search API",
      description: DESCRIPTION,
      version: VERSION,
      "x-guidance": agentGuidance(ctx),
      contact: { email: CONTACT_EMAIL },
    },
    "x-service-info": {
      categories: ["search"],
      // The guide link is relative for the same reason there is no `servers`
      // block. A reader that fetched the document has the origin to resolve it
      // against.
      docs: { homepage: HOMEPAGE, apiReference: API_REFERENCE, llms: GUIDE_PATH },
    },
    paths,
  };
}

/**
 * One paid path's operation: how to call it, what it returns, and each enabled
 * rail's offers, in the order the cold `402` lists the rails, with x402's
 * network order kept inside its slice.
 */
function operation(ctx: Context, endpoint: Endpoint): Operation {
  const { call } = endpoint;
  const rails = [
    {
      protocol: x402.PROTOCOL,
      offers: ctx.x402 === undefined ? [] : x402.offers(ctx.x402, endpoint.path),
    },
    {
      protocol: mpp.PROTOCOL,
      offers: ctx.mpp === undefined ? [] : mpp.offers(ctx.mpp, endpoint.path),
    },
  ].filter((rail) => rail.offers.length > 0);
  // The path past `/res/v1/`, such as ["local", "place_search"].
  const segments = endpoint.path.split("/").slice(3);
  const stated: Operation = {
    operationId: camelCase(segments.join("_")),
    tags: segments.slice(0, 1),
    summary: endpoint.description,
    parameters: Object.entries(call.params).map(([name, param]) => {
      // Moved out of the schema, since readers show a parameter's own
      // description and skip the one inside its schema.
      const { description, ...schema } = param;
      return {
        name,
        in: "query",
        required: call.required.includes(name),
        ...(typeof description === "string" ? { description } : {}),
        schema,
      };
    }),
    responses: {
      "200": {
        description: "Successful response",
        content: {
          "application/json": { schema: schemaOf(call.response), example: call.response },
        },
      },
      "402": { description: "Payment Required" },
    },
  };
  if (rails.length > 0) {
    stated["x-payment-info"] = {
      price: { mode: "fixed", currency: "USD", amount: priceDollars(endpoint) },
      protocols: rails.map((rail) => rail.protocol),
      offers: rails.flatMap((rail) => rail.offers),
    };
  }
  return stated;
}

/** `local_place_search` as `localPlaceSearch`. */
function camelCase(name: string): string {
  return name.replace(/_(.)/g, (_, letter: string) => letter.toUpperCase());
}

/** What the buyer's guide states about the deployment serving it. */
export interface GuideFacts {
  /** The x402 rail advertises a testnet offer. */
  testnet: boolean;
  /** The MPP rail takes payments. */
  mpp: boolean;
  /** The MPP rail settles on a testnet. */
  mpptestnet: boolean;
}

/** The facts true of the deployment running `ctx`, read from its started rails. */
export function guideFacts(ctx: Context): GuideFacts {
  return {
    testnet: ctx.x402 !== undefined && x402.servesTestnet(ctx.x402),
    mpp: ctx.mpp !== undefined,
    mpptestnet: ctx.mpp !== undefined && mpp.servesTestnet(ctx.mpp),
  };
}

/**
 * The buyer's guide, read from `llms.txt`. The guide is rendered for `ctx`
 * once. The returned function fills `{origin}` with the origin the guide was
 * fetched from, so its commands work as pasted.
 */
export function guide(ctx: Context): (origin: string) => string {
  const template = shipped("llms.txt", "the buyer's guide").toString("utf8");
  const rendered = renderGuide(template, guideFacts(ctx));
  return (origin) => rendered.replaceAll("{origin}", origin);
}

/** The service icon, read from `icon.png`. */
export function icon(): Buffer {
  return shipped("icon.png", "the service icon");
}

/**
 * A file shipped beside the package manifest. The build is `tsc` alone with no
 * bundler, so the file cannot be imported as a module. It sits one level up
 * from `src` and from the compiled `dist` alike, the same trick `version.ts`
 * uses for the manifest.
 *
 * Called when the routes are built, never at module load. A missing or
 * unreadable file refuses startup: serving a 404 instead would mean a healthy
 * looking deployment that links a file it does not have.
 */
function shipped(name: string, what: string): Buffer {
  try {
    return readFileSync(new URL(`../${name}`, import.meta.url));
  } catch (err) {
    throw AppError.invalidConfig(`${what} ${name} cannot be read: ${describe(err)}`);
  }
}

/** The path the guide's example commands buy. */
const EXAMPLE_PATH = "/res/v1/web/search";

/**
 * Keep only the parts of `template` that are true of the deployment. A line
 * `{if name}` or `{if !name}` opens a section kept when the named fact holds, or
 * does not, and a line `{end}` closes it. Sections nest. A line `{prices}`
 * becomes one table row per paid path, and `{price}` the price of the example
 * search, both read from the endpoint table so the guide cannot drift from what
 * a `402` charges. Blank lines left doubled by a dropped section close up. An
 * unknown fact or an unbalanced section refuses startup, so the guide cannot
 * quietly render wrong.
 */
export function renderGuide(template: string, facts: GuideFacts): string {
  const flags = new Map<string, boolean>(Object.entries(facts));
  const example = ENDPOINTS.find((endpoint) => endpoint.path === EXAMPLE_PATH);
  if (example === undefined) {
    throw AppError.invalidConfig(`llms.txt: the example path ${EXAMPLE_PATH} is not sold`);
  }
  const open: boolean[] = [];
  const kept: string[] = [];
  for (const line of template.split("\n")) {
    const section = /^\{if (!?)([a-z0-9]+)\}$/.exec(line);
    if (section !== null) {
      const [, not, name = ""] = section;
      const holds = flags.get(name);
      if (holds === undefined) {
        throw AppError.invalidConfig(`llms.txt: unknown section {if ${not}${name}}`);
      }
      open.push(not === "" ? holds : !holds);
      continue;
    }
    if (line === "{end}") {
      if (open.pop() === undefined) {
        throw AppError.invalidConfig("llms.txt: {end} without a matching {if}");
      }
      continue;
    }
    if (!open.every(Boolean)) {
      continue;
    }
    if (line === "{prices}") {
      kept.push(...ENDPOINTS.map(priceRow));
      continue;
    }
    kept.push(line);
  }
  if (open.length > 0) {
    throw AppError.invalidConfig("llms.txt: a section is never closed with {end}");
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replaceAll("{price}", String(example.priceBaseUnits));
}

/** One path's row in the guide's price table: base units, and dollars per thousand. */
function priceRow(endpoint: Endpoint): string {
  return `| \`${endpoint.path}\` | ${endpoint.priceBaseUnits} | $${priceDollars(endpoint, 1000)}/1k |`;
}
