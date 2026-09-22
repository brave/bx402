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
  /** What the endpoint returns, when to call it, and its main query parameters. */
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
    description:
      "Web search over Brave's independent index. Returns ranked pages with title, URL, and snippet, plus news, video, and discussion results when relevant. Use it to find current sources on any topic. Pass q, and optionally count, offset, country, search_lang, and freshness.",
    call: WEB_SEARCH,
  },
  {
    path: "/res/v1/llm/context",
    priceBaseUnits: SEARCH_RATE,
    description:
      "Web search that returns page text ready for an LLM prompt. Picks the passages most relevant to q from the top results and groups them by source URL. Use it to ground an answer in current web content without fetching pages. Size the context with maximum_number_of_tokens and maximum_number_of_urls.",
    call: LLM_CONTEXT,
  },
  {
    path: "/res/v1/news/search",
    priceBaseUnits: SEARCH_RATE,
    description:
      "News search over Brave's independent index. Returns recent articles with title, URL, source, and age. Use it for current events, where web search can surface older pages. Pass q, and optionally count, country, and freshness.",
    call: NEWS_SEARCH,
  },
  {
    path: "/res/v1/videos/search",
    priceBaseUnits: SEARCH_RATE,
    description:
      "Video search over Brave's independent index. Returns videos with title, URL, duration, creator, and publisher. Use it to find tutorials, reviews, and talks on a topic. Pass q, and optionally count, country, and freshness.",
    call: VIDEO_SEARCH,
  },
  {
    path: "/res/v1/images/search",
    priceBaseUnits: SEARCH_RATE,
    description:
      "Image search over Brave's independent index. Returns images with the page they appear on, the image URL, a thumbnail, and the size. Use it to find pictures of a subject. Pass q, and optionally count and safesearch.",
    call: IMAGE_SEARCH,
  },
  {
    path: "/res/v1/local/place_search",
    priceBaseUnits: SEARCH_RATE,
    description:
      "Place search over more than 200 million places. Returns businesses and points of interest with address, coordinates, rating, and a temporary id. Use it to find places in an area. Pass q and a location such as san francisco ca united states, or latitude and longitude.",
    call: PLACE_SEARCH,
  },
  {
    path: "/res/v1/local/pois",
    priceBaseUnits: SEARCH_RATE,
    description:
      "Details for places found by web or place search: address, opening hours, phone, rating, and reviews. Use it after a search returns location ids. Pass the ids, repeated as ids=a&ids=b. Ids expire after about 8 hours.",
    call: LOCAL_POIS,
  },
  {
    path: "/res/v1/local/descriptions",
    priceBaseUnits: SEARCH_RATE,
    description:
      "AI-generated descriptions of places found by web or place search. Use it to learn what a place is before recommending it. Pass the location ids, repeated as ids=a&ids=b. Ids expire after about 8 hours.",
    call: LOCAL_DESCRIPTIONS,
  },
];

/** The catalog keyed by path, for the per-request lookups. */
const BY_PATH = new Map<string, Endpoint>(ENDPOINTS.map((endpoint) => [endpoint.path, endpoint]));

/** The endpoint served at `path`, or `undefined` for a path we do not sell. */
export function findEndpoint(path: string): Endpoint | undefined {
  return BY_PATH.get(path);
}
