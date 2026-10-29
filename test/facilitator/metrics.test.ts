import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { custom, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Service } from "../../src/facilitator/app.js";
import {
  BALANCE_INTERVAL_MS,
  FacilitatorMetrics,
  measured,
  watchBalances,
} from "../../src/facilitator/metrics.js";
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

describe("watchBalances", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const signer = privateKeyToAccount(`0x${"11".repeat(32)}`).address;
  const networks = [{ chain: base, rpcUrl: "http://base.invalid" }];

  /** An RPC whose balance answers come from `balances` in turn, a throw for `undefined`. */
  function rpc(balances: (bigint | undefined)[]) {
    let reads = 0;
    const transport = () =>
      custom(
        {
          async request({ method }) {
            if (method !== "eth_getBalance") throw new Error(`unexpected ${method}`);
            const balance = balances[Math.min(reads, balances.length - 1)];
            reads += 1;
            if (balance === undefined) throw new Error("rpc down");
            return `0x${balance.toString(16)}`;
          },
        },
        { retryCount: 0 },
      );
    return { transport, reads: () => reads };
  }

  it("reports_the_balance_in_eth_at_once_and_on_every_interval", async () => {
    vi.useFakeTimers();
    const recorded = metrics();
    const { transport, reads } = rpc([2n * 10n ** 18n, 15n * 10n ** 17n]);
    const stop = watchBalances(recorded, signer, networks, transport);

    await vi.advanceTimersByTimeAsync(0);
    await assertRecorded(recorded, `x402_facilitator_signer_balance_eth{network="${BASE}"} 2`);
    await vi.advanceTimersByTimeAsync(BALANCE_INTERVAL_MS - 1_000);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertRecorded(recorded, `x402_facilitator_signer_balance_eth{network="${BASE}"} 1.5`);
    stop();
  });

  it("drops_the_balance_when_it_cannot_be_read_and_keeps_trying", async () => {
    vi.useFakeTimers();
    const recorded = metrics();
    const { transport } = rpc([10n ** 18n, undefined, 10n ** 18n]);
    const stop = watchBalances(recorded, signer, networks, transport);

    await vi.advanceTimersByTimeAsync(0);
    await assertRecorded(recorded, "x402_facilitator_signer_balance_eth");
    await vi.advanceTimersByTimeAsync(BALANCE_INTERVAL_MS);
    await assertNotRecorded(recorded, "x402_facilitator_signer_balance_eth{");
    await vi.advanceTimersByTimeAsync(BALANCE_INTERVAL_MS);
    await assertRecorded(recorded, `x402_facilitator_signer_balance_eth{network="${BASE}"} 1`);
    stop();
  });

  it("warns_of_a_failed_read_without_naming_the_rpc", async () => {
    const written = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // A closed local port, with a provider key in the path as paid RPCs carry one.
    const rpcUrl = "http://127.0.0.1:9/v2/provider-key";
    const stop = watchBalances(metrics(), signer, [{ chain: base, rpcUrl }], (url) =>
      http(url, { retryCount: 0 }),
    );

    try {
      await vi.waitFor(() => expect(written).toHaveBeenCalled());
      const line = String(written.mock.calls[0]?.[0]);
      expect(line).toContain("reading the signer balance on Base failed: HTTP request failed.");
      expect(line).not.toContain("provider-key");
    } finally {
      stop();
      written.mockRestore();
    }
  });

  it("stops_reading_once_stopped", async () => {
    vi.useFakeTimers();
    const { transport, reads } = rpc([1n]);
    const stop = watchBalances(metrics(), signer, networks, transport);

    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5 * BALANCE_INTERVAL_MS);
    expect(reads()).toBe(1);
  });
});
