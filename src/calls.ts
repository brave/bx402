/**
 * How to call each paid path: the query parameters Brave documents for it, and a
 * sample call with the response it returns.
 *
 * Only the parameters most calls need are listed. The service forwards the query
 * string without reading it, so Brave's other parameters still work. Names, types,
 * and limits follow Brave's API reference. The sample responses keep one result and
 * a few of its fields.
 */

/** The JSON Schema for one query parameter. */
export type Param = Readonly<Record<string, unknown>>;

/** How to call one paid path. */
export interface Call {
  /** The query parameters, keyed by name. */
  readonly params: Readonly<Record<string, Param>>;
  /** The parameters a call must send. */
  readonly required: readonly string[];
  /** A query that satisfies `params`. */
  readonly query: Readonly<Record<string, unknown>>;
  /** What Brave returns for `query`. */
  readonly response: Readonly<Record<string, unknown>>;
}

function searchQuery(maxLength: number): Param {
  return { type: "string", maxLength, description: "Search query" };
}

function count(maximum: number, fallback: number): Param {
  return { type: "integer", minimum: 1, maximum, default: fallback };
}

function safesearch(values: readonly string[], fallback: string): Param {
  return { type: "string", enum: values, default: fallback };
}

const OFFSET: Param = {
  type: "integer",
  minimum: 0,
  maximum: 9,
  description: "Pages of count results to skip",
};

const COUNTRY: Param = { type: "string", description: "Country code such as US, or ALL" };

const SEARCH_LANG: Param = { type: "string", description: "Language code such as en" };

const FRESHNESS: Param = {
  type: "string",
  description: "pd, pw, pm, py, or a range like 2026-01-01to2026-06-30",
};

const SAFESEARCH_LEVELS = ["off", "moderate", "strict"];

/** The parameters web, news, and video search share. */
function pagedSearch(maxQuery: number, maxCount: number, safe: string): Record<string, Param> {
  return {
    q: searchQuery(maxQuery),
    count: count(maxCount, 20),
    offset: OFFSET,
    country: COUNTRY,
    search_lang: SEARCH_LANG,
    freshness: FRESHNESS,
    safesearch: safesearch(SAFESEARCH_LEVELS, safe),
  };
}

export const WEB_SEARCH: Call = {
  params: pagedSearch(600, 20, "moderate"),
  required: ["q"],
  query: { q: "brave browser", count: 5 },
  response: {
    type: "search",
    query: { original: "brave browser" },
    web: {
      type: "search",
      results: [
        {
          title: "The browser that puts you first | Brave",
          url: "https://brave.com/",
          description:
            "The Brave browser is <strong>a fast, private and secure web browser for PC, Mac and mobile</strong>.",
          page_age: "2026-09-18T00:00:00",
        },
      ],
    },
  },
};
