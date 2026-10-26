import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "../src/endpoints.js";

describe("calls", () => {
  it("a_sample_query_uses_only_declared_parameters", () => {
    // The schema admits parameters it does not list, so a sample using one would
    // still validate.
    for (const { path, call } of ENDPOINTS) {
      for (const name of Object.keys(call.query)) {
        expect(Object.keys(call.params), `${path} ${name}`).toContain(name);
      }
    }
  });
});
