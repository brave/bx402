import { HTTPFacilitatorClient } from "@x402/core/http";
import { custom, type Hex, http, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkNetworks,
  facilitator,
  RECEIPT_TIMEOUT_MS,
  settlementClient,
  settlementSigner,
} from "../../src/facilitator/core.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

/** Both networks, with endpoints that are never dialed. */
const networks = [
  { chain: base, rpcUrl: "http://base.invalid" },
  { chain: baseSepolia, rpcUrl: "http://sepolia.invalid" },
];

describe("facilitator", () => {
  it("supports_only_x402_v2_exact_signed_by_its_account", () => {
    expect(facilitator(account, networks).getSupported()).toEqual({
      kinds: [
        { x402Version: 2, scheme: "exact", network: "eip155:8453" },
        { x402Version: 2, scheme: "exact", network: "eip155:84532" },
      ],
      extensions: [],
      signers: { "eip155:*": [account.address] },
    });
  });
});

/**
 * A settlement client on a chain that always reports five transactions sent
 * from the account so far. `broadcasts` holds the nonce of each transaction
 * it accepts, after it refuses the first `refusing`.
 */
function onChainWithFive(refusing = 0) {
  const broadcasts: number[] = [];
  let refused = 0;
  const transport = custom(
    {
      async request({ method, params }) {
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_getTransactionCount") return "0x5";
        if (method === "eth_sendRawTransaction") {
          if (refused < refusing) {
            refused += 1;
            throw new Error("refused");
          }
          broadcasts.push(parseTransaction((params as [Hex])[0]).nonce ?? -1);
          return `0x${"ab".repeat(32)}`;
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    { retryCount: 0 },
  );
  const client = settlementClient(account, baseSepolia, transport);
  const send = () =>
    client.sendTransaction({
      to: account.address,
      value: 0n,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
  return { broadcasts, send };
}

describe("settlementClient", () => {
  it("concurrent_sends_each_get_the_next_nonce", async () => {
    const { broadcasts, send } = onChainWithFive();
    await Promise.all([send(), send(), send()]);
    expect(broadcasts.sort((a, b) => a - b)).toEqual([5, 6, 7]);
  });

  it("a_refused_send_leaves_no_gap", async () => {
    const { broadcasts, send } = onChainWithFive(1);
    await expect(send()).rejects.toThrow();
    await send();
    expect(broadcasts).toEqual([5]);
  });
});

describe("settlementSigner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives_up_on_a_receipt_after_the_timeout", async () => {
    vi.useFakeTimers();
    // A chain that never mines the transaction.
    const transport = custom(
      {
        async request({ method }) {
          if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
          if (method === "eth_blockNumber") return "0x1";
          if (method === "eth_getTransactionReceipt" || method === "eth_getTransactionByHash") {
            return null;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      { retryCount: 0 },
    );
    const signer = settlementSigner(account, baseSepolia, transport);
    let settled = false;
    const waiting = signer
      .waitForTransactionReceipt({ hash: `0x${"ab".repeat(32)}` })
      .finally(() => {
        settled = true;
      });
    waiting.catch(() => {});

    await vi.advanceTimersByTimeAsync(RECEIPT_TIMEOUT_MS - 1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).rejects.toThrow(/Timed out/);
  });

  it("gives_up_before_a_resource_server_stops_waiting", () => {
    const client = new HTTPFacilitatorClient({ url: "http://facilitator.invalid" });
    expect(RECEIPT_TIMEOUT_MS).toBeLessThan(client.timeoutMs);
  });
});

/** An RPC per URL that reports `chainId` and a balance of `balance` wei for any address. */
function rpcs(answers: Record<string, { chainId: number; balance?: bigint }>) {
  return (rpcUrl: string) =>
    custom(
      {
        async request({ method }) {
          const answer = answers[rpcUrl];
          if (answer === undefined) throw new Error(`no rpc for ${rpcUrl}`);
          const { chainId, balance = 1n } = answer;
          if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
          if (method === "eth_getBalance") return `0x${balance.toString(16)}`;
          throw new Error(`unexpected ${method}`);
        },
      },
      { retryCount: 0 },
    );
}

const healthy = {
  "http://base.invalid": { chainId: base.id },
  "http://sepolia.invalid": { chainId: baseSepolia.id },
};

describe("checkNetworks", () => {
  it("passes_when_every_rpc_serves_its_chain_and_the_signer_has_gas", async () => {
    await checkNetworks(account.address, networks, rpcs(healthy));
  });

  it("refuses_an_rpc_serving_another_chain", async () => {
    const answers = { ...healthy, "http://sepolia.invalid": { chainId: 1 } };
    await expect(checkNetworks(account.address, networks, rpcs(answers))).rejects.toThrow(
      `Base Sepolia RPC serves chain 1, expected ${baseSepolia.id}`,
    );
  });

  it("refuses_a_signer_with_no_eth_on_a_network", async () => {
    const answers = { ...healthy, "http://base.invalid": { chainId: base.id, balance: 0n } };
    await expect(checkNetworks(account.address, networks, rpcs(answers))).rejects.toThrow(
      `signer ${account.address} holds no ETH on Base`,
    );
  });

  it("refuses_an_unreachable_rpc_without_naming_its_url", async () => {
    // A closed local port, with a provider key in the path as paid RPCs carry one.
    const rpcUrl = "http://127.0.0.1:9/v2/provider-key";
    const failure = checkNetworks(account.address, [{ chain: base, rpcUrl }], (url) =>
      http(url, { retryCount: 0 }),
    );
    await expect(failure).rejects.toThrow("Base RPC: HTTP request failed.");
    await expect(failure).rejects.not.toThrow("provider-key");
  });
});
