/**
 * The paid surface: which Brave Search API endpoints we proxy and what each costs.
 *
 * One table, read by the router and by both payment rails, so the path we serve,
 * the price we advertise, and the price we verify against can never drift apart.
 * The table is protocol-neutral: it names no rail and imports nothing from one.
 */

import {
  type Call,
  IMAGE_SEARCH,
  LLM_CONTEXT,
  LOCAL_DESCRIPTIONS,
  LOCAL_POIS,
  NEWS_SEARCH,
  PLACE_SEARCH,
  VIDEO_SEARCH,
  WEB_SEARCH,
} from "./calls.js";

/** Brave's Web Search and LLM Context rate, $5.00 per 1,000 requests. */
const SEARCH_RATE = 5_000;

/** One paid endpoint: the path we serve, what it costs, and how we label it. */
export interface Endpoint {
  /**
   * Path we accept and forward upstream unchanged, so our route and Brave's are
   * the same string.
   */
  readonly path: string;
  /**
   * Price for one request, in base units of the rail's currency.
   *
   * One number serves both rails because USDC and pathUSD both carry 6 decimals,
   * so `5_000` is $0.005 on either. A rail with a different scale would have to
   * convert rather than read this directly.
   */
  readonly priceBaseUnits: number;
  /** Label for this endpoint in the payment challenge. */
  readonly description: string;
  /** How to call it. */
  readonly call: Call;
}

/**
 * Every endpoint a client can pay for.
 *
 * Prices come from Brave's published rates. The rate card names only Web Search
 * and LLM Context; the other search endpoints are charged the Web rate, which
 * never bills under the published tier.
 *
 * Three kinds of endpoint are absent on purpose:
 *
 * - the Answers API, which is metered per query and per token, and so cannot be
 *   sold at one fixed price.
 * - Autosuggest and Spellcheck, which Brave prices at $0.0005 a query, while the
 *   facilitator takes about $0.001 for every payment it settles. One payment per
 *   query would cost more to collect than the query is worth, so these can only be
 *   sold once many queries settle together as one payment.
 * - the Summarizer, which Brave has deprecated and may remove without notice.
 */
export const ENDPOINTS: readonly Endpoint[] = [
  {
    path: "/res/v1/web/search",
    priceBaseUnits: SEARCH_RATE,
    description: "Brave Search API - Web / Search",
    call: WEB_SEARCH,
  },
  {
    path: "/res/v1/llm/context",
    priceBaseUnits: SEARCH_RATE,
    description: "Brave Search API - LLM Context",
    call: LLM_CONTEXT,
  },
  {
    path: "/res/v1/news/search",
    priceBaseUnits: SEARCH_RATE,
    description: "Brave Search API - News / Search",
    call: NEWS_SEARCH,
  },
  {
    path: "/res/v1/videos/search",
    priceBaseUnits: SEARCH_RATE,
    description: "Brave Search API - Video / Search",
    call: VIDEO_SEARCH,
  },
  {
    path: "/res/v1/images/search",
    priceBaseUnits: SEARCH_RATE,
    description: "Brave Search API - Image / Search",
    call: IMAGE_SEARCH,
  },
  {
    path: "/res/v1/local/place_search",
    priceBaseUnits: SEARCH_RATE,
    description: "Brave Search API - Place / Search",
    call: PLACE_SEARCH,
  },
  {
    path: "/res/v1/local/pois",
    priceBaseUnits: SEARCH_RATE,
    description: "Brave Search API - Local / POIs",
    call: LOCAL_POIS,
  },
  {
    path: "/res/v1/local/descriptions",
    priceBaseUnits: SEARCH_RATE,
    description: "Brave Search API - Local / Descriptions",
    call: LOCAL_DESCRIPTIONS,
  },
];

/** The catalog keyed by path, for the per-request lookups. */
const BY_PATH = new Map<string, Endpoint>(ENDPOINTS.map((endpoint) => [endpoint.path, endpoint]));

/** The endpoint served at `path`, or `undefined` for a path we do not sell. */
export function findEndpoint(path: string): Endpoint | undefined {
  return BY_PATH.get(path);
}
