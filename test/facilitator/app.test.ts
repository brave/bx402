import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { facilitatorApp, type Service } from "../../src/facilitator/app.js";
import { facilitator } from "../../src/facilitator/core.js";

const FACILITATOR_URL = "http://facilitator.invalid";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x000000000000000000000000000000000000dEaD",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

const payload: PaymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: { signature: "0x00", authorization: { from: account.address } },
};

/** A facilitator whose verify and settle answer as a test says. */
function fake(answers: Partial<Pick<Service, "verify" | "settle">>): Service {
  const unused = () => Promise.reject(new Error("not expected"));
  return {
    getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
    verify: answers.verify ?? unused,
    settle: answers.settle ?? unused,
  };
}

/** The SDK's own client, with its requests answered by `app` instead of a socket. */
function clientFor(app: Hono): HTTPFacilitatorClient {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    app.request(input, init),
  );
  return new HTTPFacilitatorClient({ url: FACILITATOR_URL });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("facilitatorApp", () => {
  it("supported_reaches_the_client_as_the_facilitator_reports_it", async () => {
    const service = facilitator(account, [
      { chain: base, rpcUrl: "http://base.invalid" },
      { chain: baseSepolia, rpcUrl: "http://sepolia.invalid" },
    ]);
    const client = clientFor(facilitatorApp(service));
    expect(await client.getSupported()).toEqual(service.getSupported());
  });

  it("verify_returns_a_valid_and_a_refused_verdict_as_an_answer", async () => {
    const valid = { isValid: true, payer: account.address };
    const refused = { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" };
    for (const verdict of [valid, refused]) {
      const verify = vi.fn(async () => verdict);
      const client = clientFor(facilitatorApp(fake({ verify })));
      expect(await client.verify(payload, requirements)).toEqual(verdict);
      expect(verify).toHaveBeenCalledWith(payload, requirements);
    }
  });

  it("settle_returns_the_receipt_and_a_failed_settle_as_an_answer", async () => {
    const settled = {
      success: true,
      transaction: `0x${"ab".repeat(32)}`,
      network: "eip155:84532",
      payer: account.address,
    } as const;
    const failed = {
      success: false,
      errorReason: "transaction_failed",
      transaction: "",
      network: "eip155:84532",
    } as const;
    for (const receipt of [settled, failed]) {
      const client = clientFor(facilitatorApp(fake({ settle: async () => receipt })));
      expect(await client.settle(payload, requirements)).toEqual(receipt);
    }
  });

  it("a_facilitator_that_cannot_decide_answers_500", async () => {
    const app = facilitatorApp(fake({ settle: () => Promise.reject(new Error("rpc down")) }));
    await expect(clientFor(app).settle(payload, requirements)).rejects.toThrow(
      "Facilitator settle failed (500)",
    );
  });

  it("a_body_that_is_not_a_v2_payment_answers_400", async () => {
    const app = facilitatorApp(fake({}));
    for (const body of ["not json", JSON.stringify({ paymentPayload: { x402Version: 1 } })]) {
      const response = await app.request("/verify", { method: "POST", body });
      expect(response.status, body).toBe(400);
    }
  });

  it("health_answers_and_other_methods_and_paths_do_not", async () => {
    const app = facilitatorApp(fake({}));
    expect((await app.request("/health")).status).toBe(200);
    const wrong = await app.request("/verify");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect((await app.request("/supported", { method: "POST" })).status).toBe(405);
    expect((await app.request("/nope")).status).toBe(404);
  });
});
