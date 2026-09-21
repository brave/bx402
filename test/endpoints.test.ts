import { describe, expect, it } from "vitest";
import { ENDPOINTS, findEndpoint } from "../src/endpoints.js";

describe("endpoints", () => {
  it("every_path_is_listed_once", () => {
    const distinct = new Set(ENDPOINTS.map((endpoint) => endpoint.path));
    expect(distinct.size).toBe(ENDPOINTS.length);
  });

  it("find_matches_a_served_path_exactly", () => {
    const found = findEndpoint("/res/v1/images/search");
    expect(found?.priceBaseUnits).toBe(5_000);

    // Three paths are deliberately not sold: the Answers API, and the two that
    // cost less than settling one payment. A prefix of a served path is not a
    // served path either.
    expect(findEndpoint("/res/v1/chat/completions")).toBeUndefined();
    expect(findEndpoint("/res/v1/suggest/search")).toBeUndefined();
    expect(findEndpoint("/res/v1/spellcheck/search")).toBeUndefined();
    expect(findEndpoint("/res/v1/images")).toBeUndefined();
  });
});
