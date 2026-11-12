import { describe, expect, it } from "vitest";
import { challenge, failure, Metrics, outcome, screening, step } from "../src/metrics.js";
import { VERSION } from "../src/version.js";
import { assertNotRecorded, assertRecorded } from "./support.js";

describe("metrics", () => {
  it("the_exposition_carries_the_running_version", async () => {
    const rendered = await new Metrics().render();
    expect(rendered).toContain(`bx402_build_info{version="${VERSION}"} 1`);
  });

  it("the_exposition_ends_the_way_openmetrics_requires", async () => {
    const rendered = await new Metrics().render();
    expect(rendered.endsWith("# EOF\n")).toBe(true);
  });

  it("every_challenge_starts_at_zero", async () => {
    const metrics = new Metrics();
    for (const reason of Object.values(challenge)) {
      await assertRecorded(
        metrics,
        `bx402_challenges_total{endpoint="/res/v1/web/search",reason="${reason}"} 0`,
      );
    }
  });

  it("screening_starts_at_zero_only_where_it_runs", async () => {
    const metrics = new Metrics();
    await assertNotRecorded(metrics, "bx402_screenings_total{");

    metrics.screens();
    for (const decided of Object.values(screening)) {
      await assertRecorded(metrics, `bx402_screenings_total{outcome="${decided}"} 0`);
    }
  });

  it("a_client_is_counted_under_the_name_it_sends_or_not_at_all", async () => {
    const metrics = new Metrics();
    metrics.recordClient("mppx/0.9.2", "x402");
    // The x402 JavaScript SDKs send no User-Agent, which is its own answer.
    metrics.recordClient(undefined, "x402");
    metrics.recordClient("", "none");

    await assertRecorded(metrics, 'bx402_client_requests_total{client="mppx",attempted="x402"} 1');
    await assertRecorded(metrics, 'bx402_client_requests_total{client="none",attempted="x402"} 1');
    await assertRecorded(metrics, 'bx402_client_requests_total{client="none",attempted="none"} 1');
  });

  it("a_client_cannot_name_itself_into_a_series_of_its_own", async () => {
    const metrics = new Metrics();
    metrics.recordClient("SomethingNobodyKnows/3.1", "mpp");
    metrics.recordClient("AnotherOne/1.0", "mpp");

    await assertRecorded(metrics, 'bx402_client_requests_total{client="other",attempted="mpp"} 2');
    await assertNotRecorded(metrics, "SomethingNobodyKnows");
  });

  it("payers_are_reported_as_a_count_and_never_as_addresses", async () => {
    const metrics = new Metrics();
    metrics.recordPayer("x402", "0xdeadbeef");
    metrics.recordPayer("x402", "0xdeadbeef");
    metrics.recordPayer("x402", "0xfeedface");

    await assertRecorded(metrics, 'bx402_distinct_payers{rail="x402"} 2');
    await assertNotRecorded(metrics, "0xdeadbeef");
  });

  it("a_sold_endpoint_starts_the_rails_outcomes_at_zero_and_no_others", async () => {
    const metrics = new Metrics();
    metrics.sells(
      "x402",
      "/res/v1/web/search",
      [outcome.SETTLED, outcome.REFUSED],
      ["USDC on Base"],
    );

    for (const ended of [outcome.SETTLED, outcome.REFUSED]) {
      await assertRecorded(
        metrics,
        `bx402_payments_total{rail="x402",endpoint="/res/v1/web/search",outcome="${ended}"} 0`,
      );
    }
    await assertNotRecorded(metrics, `outcome="${outcome.UNSUPPORTED}"`);

    // Sold in no asset means not sold on this rail at all.
    metrics.sells("mpp", "/res/v1/web/search", [outcome.SETTLED], []);
    await assertNotRecorded(metrics, 'rail="mpp"');
    await assertRecorded(
      metrics,
      'bx402_charged_base_units_total{rail="x402",endpoint="/res/v1/web/search",asset="USDC on Base"} 0',
    );
  });

  it("a_failure_is_counted_under_the_step_that_failed", async () => {
    const metrics = new Metrics();
    metrics.recordFailure("x402", step.SETTLE, failure.ALREADY_USED);
    await assertRecorded(
      metrics,
      'bx402_payment_failures_total{rail="x402",step="settle",reason="already_used"} 1',
    );
  });

  it("a_fast_answer_is_timed_in_milliseconds", async () => {
    const metrics = new Metrics();
    metrics.recordRequest("/res/v1/web/search", "GET", 402, 0.003);
    await assertRecorded(
      metrics,
      'bx402_http_request_duration_seconds_bucket{le="0.005",endpoint="/res/v1/web/search",method="GET"} 1',
    );
  });

  it("the_process_is_reported_only_once_asked_for", async () => {
    const metrics = new Metrics();
    expect(await metrics.render()).not.toContain("process_start_time_seconds");

    metrics.collectProcessMetrics();

    const rendered = await metrics.render();
    expect(rendered).toContain("process_start_time_seconds");
    expect(rendered).toContain("nodejs_heap_size_used_bytes");
    expect(rendered.endsWith("# EOF\n")).toBe(true);
  });
});
