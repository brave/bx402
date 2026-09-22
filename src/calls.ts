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

export const LLM_CONTEXT: Call = {
  params: {
    q: searchQuery(600),
    count: count(50, 20),
    country: COUNTRY,
    search_lang: SEARCH_LANG,
    freshness: FRESHNESS,
    maximum_number_of_urls: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    maximum_number_of_tokens: { type: "integer", minimum: 1024, maximum: 32768, default: 8192 },
  },
  required: ["q"],
  query: { q: "brave browser", maximum_number_of_tokens: 2048 },
  response: {
    grounding: {
      generic: [
        {
          url: "https://brave.com/",
          title: "The browser that puts you first | Brave",
          snippets: [
            "The Brave browser is a fast, private and secure web browser for PC, Mac and mobile.",
          ],
        },
      ],
    },
    sources: {
      "https://brave.com/": {
        title: "The browser that puts you first | Brave",
        hostname: "brave.com",
      },
    },
  },
};

export const NEWS_SEARCH: Call = {
  params: pagedSearch(400, 50, "strict"),
  required: ["q"],
  query: { q: "brave browser", freshness: "pm" },
  response: {
    type: "news",
    query: { original: "brave browser" },
    results: [
      {
        type: "news_result",
        title: "Brave's browser one-ups Chrome with its new support for email aliases | TechCrunch",
        url: "https://techcrunch.com/2026/08/28/braves-browser-one-ups-chrome-with-its-new-support-for-email-aliases/",
        age: "4 weeks ago",
        page_age: "2026-08-28T18:50:00",
      },
    ],
  },
};

export const VIDEO_SEARCH: Call = {
  params: pagedSearch(400, 50, "moderate"),
  required: ["q"],
  query: { q: "brave browser", count: 5 },
  response: {
    type: "videos",
    query: { original: "brave browser" },
    results: [
      {
        type: "video_result",
        title: "Brave Just Released a Paid Browser: Here's What You Need to Know - YouTube",
        url: "https://www.youtube.com/watch?v=3i5KH0l895o",
        age: "April 17, 2026",
        video: { duration: "08:38", creator: "Techlore", publisher: "YouTube" },
      },
    ],
  },
};
