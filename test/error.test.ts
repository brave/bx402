import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";
import { AppError, describe as describeError } from "../src/error.js";

describe("error", () => {
  it("bad_request_maps_to_400", () => {
    expect(AppError.badRequest("q is required").toResponse().status).toBe(400);
  });

  it("missing_config_maps_to_500", () => {
    expect(AppError.missingConfig("BRAVE_SEARCH_API_KEY").toResponse().status).toBe(500);
  });

  it("invalid_config_maps_to_500", () => {
    expect(AppError.invalidConfig("X402_FACILITATOR_URL: bad").toResponse().status).toBe(500);
  });

  it("a_failure_reads_out_with_its_causes", () => {
    const err = new Error("settle failed", { cause: new Error("connection reset") });
    expect(describeError(err)).toBe("settle failed: connection reset");
  });

  it("an_rpc_failure_never_logs_the_url_that_may_hold_a_provider_key", async () => {
    // Nothing listens on port 9, so the request fails after naming its URL.
    const client = createPublicClient({
      transport: http("http://127.0.0.1:9/v2/provider-key", { retryCount: 0 }),
    });
    const err = await client.getChainId().catch((caught: unknown) => caught);

    const logged = describeError(err);
    expect(logged).toMatch(/^HTTP request failed\./);
    expect(logged).not.toContain("provider-key");
  });
});
