import { base, baseSepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import { facilitatorConfigFromEnv } from "../../src/facilitator/config.js";

/** A well-formed key that holds nothing. */
const KEY = `0x${"11".repeat(32)}`;

const RPC = { BASE_RPC_URL: "https://base.example" };

/** The error `facilitatorConfigFromEnv` throws for `env`, as a message. */
function errorFor(env: NodeJS.ProcessEnv): string {
  try {
    facilitatorConfigFromEnv(env);
  } catch (err: unknown) {
    return (err as Error).message;
  }
  throw new Error("expected the config to be refused");
}

describe("facilitator config", () => {
  it("reads_either_key_kind", () => {
    expect(facilitatorConfigFromEnv({ ...RPC, FACILITATOR_KMS_KEY_ID: "key-id" })).toEqual({
      signer: { kind: "kms", keyId: "key-id" },
      networks: [{ chain: base, rpcUrl: "https://base.example" }],
      port: 8080,
    });
    expect(facilitatorConfigFromEnv({ ...RPC, FACILITATOR_PRIVATE_KEY: KEY }).signer).toEqual({
      kind: "privateKey",
      key: KEY,
    });
  });

  it("needs_exactly_one_key", () => {
    expect(errorFor({ ...RPC })).toMatch(/FACILITATOR_KMS_KEY_ID or FACILITATOR_PRIVATE_KEY/);
    expect(errorFor({ ...RPC, FACILITATOR_KMS_KEY_ID: "", FACILITATOR_PRIVATE_KEY: "" })).toMatch(
      /FACILITATOR_KMS_KEY_ID or FACILITATOR_PRIVATE_KEY/,
    );
    expect(
      errorFor({ ...RPC, FACILITATOR_KMS_KEY_ID: "key-id", FACILITATOR_PRIVATE_KEY: KEY }),
    ).toMatch(/both set/);
  });

  it("refuses_a_malformed_key_without_logging_it", () => {
    for (const malformed of [KEY.slice(2), `${KEY}00`, `0x${"zz".repeat(32)}`]) {
      const message = errorFor({ ...RPC, FACILITATOR_PRIVATE_KEY: malformed });
      expect(message).toMatch(/expected 0x and 64 hex digits/);
      expect(message).not.toContain(malformed);
    }
  });

  it("settles_on_each_network_given_an_rpc_and_needs_at_least_one", () => {
    expect(errorFor({ FACILITATOR_KMS_KEY_ID: "key-id" })).toMatch(
      /BASE_RPC_URL or BASE_SEPOLIA_RPC_URL/,
    );
    expect(
      facilitatorConfigFromEnv({
        ...RPC,
        FACILITATOR_KMS_KEY_ID: "key-id",
        BASE_SEPOLIA_RPC_URL: "https://sepolia.example",
      }).networks,
    ).toEqual([
      { chain: base, rpcUrl: "https://base.example" },
      { chain: baseSepolia, rpcUrl: "https://sepolia.example" },
    ]);
  });

  it("ignores_allow_testnet", () => {
    // Only the RPC endpoints decide the networks, so the flag neither adds Base
    // Sepolia nor makes its endpoint required.
    const env = { ...RPC, FACILITATOR_KMS_KEY_ID: "key-id", ALLOW_TESTNET: "true" };
    expect(facilitatorConfigFromEnv(env).networks).toEqual([
      { chain: base, rpcUrl: "https://base.example" },
    ]);
  });

  it("reads_the_port_and_refuses_a_malformed_one", () => {
    const env = { ...RPC, FACILITATOR_KMS_KEY_ID: "key-id" };
    expect(facilitatorConfigFromEnv({ ...env, FACILITATOR_PORT: "9090" }).port).toBe(9090);
    expect(facilitatorConfigFromEnv({ ...env, FACILITATOR_PORT: "0" }).port).toBe(0);
    for (const malformed of ["http", "-1", "80.5", "65536"]) {
      expect(errorFor({ ...env, FACILITATOR_PORT: malformed })).toMatch(
        /FACILITATOR_PORT: expected a port number/,
      );
    }
  });

  it("settles_on_base_sepolia_alone_when_no_mainnet_rpc_is_set", () => {
    expect(
      facilitatorConfigFromEnv({
        FACILITATOR_PRIVATE_KEY: KEY,
        BASE_SEPOLIA_RPC_URL: "https://sepolia.example",
      }).networks,
    ).toEqual([{ chain: baseSepolia, rpcUrl: "https://sepolia.example" }]);
  });
});
