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
      baseRpcUrl: "https://base.example",
      baseSepoliaRpcUrl: undefined,
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

  it("needs_the_rpc_for_each_network_it_settles_on", () => {
    expect(errorFor({ FACILITATOR_KMS_KEY_ID: "key-id" })).toMatch(/BASE_RPC_URL/);

    const testnet = { ...RPC, FACILITATOR_KMS_KEY_ID: "key-id", ALLOW_TESTNET: "true" };
    expect(errorFor(testnet)).toMatch(/BASE_SEPOLIA_RPC_URL/);
    expect(
      facilitatorConfigFromEnv({ ...testnet, BASE_SEPOLIA_RPC_URL: "https://sepolia.example" })
        .baseSepoliaRpcUrl,
    ).toBe("https://sepolia.example");
  });
});
