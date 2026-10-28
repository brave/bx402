import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import { facilitator } from "../../src/facilitator/core.js";

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
