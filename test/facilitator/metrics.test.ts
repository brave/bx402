import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { base } from "viem/chains";
import { describe, expect, it } from "vitest";
import type { Service } from "../../src/facilitator/app.js";
import { FacilitatorMetrics, measured } from "../../src/facilitator/metrics.js";
import { VERSION } from "../../src/version.js";
import { assertNotRecorded, assertRecorded } from "../support.js";

const BASE = "eip155:8453";

/** The payload is never read by the stand-in service, only the network. */
const payload = {} as PaymentPayload;
const on = (network: string) => ({ network }) as PaymentRequirements;

/** A service that answers settle with `settled` and verify with `valid`. */
function service(settled: Partial<SettleResponse>, valid = true): Service {
  return {
    getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
    verify: async () => ({ isValid: valid }),
    settle: async () => ({ success: false, transaction: "", network: BASE, ...settled }),
  };
}

const metrics = () => new FacilitatorMetrics([{ chain: base, rpcUrl: "http://base.invalid" }]);

describe("facilitator metrics", () => {
  it("the_exposition_carries_the_running_version", async () => {
    await assertRecorded(metrics(), `x402_facilitator_build_info{version="${VERSION}"} 1`);
  });

  it("a_verify_is_counted_by_its_verdict", async () => {
    const recorded = metrics();
    await measured(service({}, true), recorded).verify(payload, on(BASE));
    await measured(service({}, false), recorded).verify(payload, on(BASE));

    for (const outcome of ["valid", "invalid"]) {
      await assertRecorded(
        recorded,
        `x402_facilitator_requests_total{step="verify",network="${BASE}",outcome="${outcome}"} 1`,
      );
    }
  });

  it("a_settlement_is_counted_as_settled_refused_or_pending", async () => {
    const recorded = metrics();
    await measured(service({ success: true }), recorded).settle(payload, on(BASE));
    await measured(
      service({ errorReason: "invalid_exact_evm_nonce_already_used" }),
      recorded,
    ).settle(payload, on(BASE));
    await measured(service({ errorReason: "settlement_pending" }), recorded).settle(
      payload,
      on(BASE),
    );

    for (const outcome of ["settled", "refused", "pending"]) {
      await assertRecorded(
        recorded,
        `x402_facilitator_requests_total{step="settle",network="${BASE}",outcome="${outcome}"} 1`,
      );
    }
    await assertRecorded(
      recorded,
      `x402_facilitator_duration_seconds_count{step="settle",network="${BASE}"} 3`,
    );
  });

  it("a_throw_is_counted_as_an_error_and_passed_on", async () => {
    const recorded = metrics();
    const failing = { ...service({}), settle: () => Promise.reject(new Error("rpc down")) };

    await expect(measured(failing, recorded).settle(payload, on(BASE))).rejects.toThrow("rpc down");
    await assertRecorded(
      recorded,
      `x402_facilitator_requests_total{step="settle",network="${BASE}",outcome="error"} 1`,
    );
    await assertRecorded(recorded, `x402_facilitator_settlements_in_flight{network="${BASE}"} 0`);
  });

  it("a_settlement_is_in_flight_until_it_is_answered", async () => {
    const recorded = metrics();
    let answer: (settled: SettleResponse) => void = () => {};
    const held = {
      ...service({}),
      settle: () =>
        new Promise<SettleResponse>((resolve) => {
          answer = resolve;
        }),
    };

    const settling = measured(held, recorded).settle(payload, on(BASE));
    await assertRecorded(recorded, `x402_facilitator_settlements_in_flight{network="${BASE}"} 1`);
    answer({ success: true, transaction: "", network: BASE });
    await settling;
    await assertRecorded(recorded, `x402_facilitator_settlements_in_flight{network="${BASE}"} 0`);
  });

  it("a_network_it_does_not_settle_on_cannot_mint_a_series", async () => {
    const recorded = metrics();
    await measured(service({}), recorded).verify(payload, on("eip155:1"));

    await assertRecorded(
      recorded,
      'x402_facilitator_requests_total{step="verify",network="other",outcome="valid"} 1',
    );
    await assertNotRecorded(recorded, "eip155:1");
  });
});
