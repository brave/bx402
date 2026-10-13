import { describe, expect, it } from "vitest";
import { failure, Metrics, step } from "../src/metrics.js";
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

  it("payers_are_reported_as_a_count_and_never_as_addresses", async () => {
    const metrics = new Metrics();
    metrics.recordPayer("x402", "0xdeadbeef");
    metrics.recordPayer("x402", "0xdeadbeef");
    metrics.recordPayer("x402", "0xfeedface");

    await assertRecorded(metrics, 'bx402_distinct_payers{rail="x402"} 2');
    await assertNotRecorded(metrics, "0xdeadbeef");
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
