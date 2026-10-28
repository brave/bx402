import { custom, type Hex, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import { facilitator, settlementClient } from "../../src/facilitator/core.js";

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
