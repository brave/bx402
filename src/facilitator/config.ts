/**
 * Runtime configuration for the x402 facilitator, read from the environment at
 * startup.
 */

import { allowTestnetFromEnv, optionalVar, requireVar } from "../env.js";
import { AppError } from "../error.js";

/**
 * Where the key that pays gas and submits settlements lives: in AWS KMS, where
 * it never reaches this process, or in the environment as a raw private key.
 */
export type SignerSource =
  | { kind: "kms"; keyId: string }
  | { kind: "privateKey"; key: `0x${string}` };

/** Runtime configuration for the facilitator, read once from the environment at startup. */
export interface FacilitatorConfig {
  /** The key that signs settlement transactions. */
  signer: SignerSource;
  /** Base mainnet RPC endpoint. */
  baseRpcUrl: string;
  /** Base Sepolia RPC endpoint, present only when testnets are allowed. */
  baseSepoliaRpcUrl: string | undefined;
}

/**
 * Read configuration from the process environment:
 *
 * - `FACILITATOR_KMS_KEY_ID`: AWS KMS key that signs settlements.
 * - `FACILITATOR_PRIVATE_KEY`: a raw private key instead. Exactly one of the two
 *   must be set.
 * - `BASE_RPC_URL` (required): Base mainnet RPC endpoint.
 * - `BASE_SEPOLIA_RPC_URL` (required with `ALLOW_TESTNET`): Base Sepolia RPC endpoint.
 * - `ALLOW_TESTNET` (optional): `true` also settles on Base Sepolia.
 */
export function facilitatorConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  return {
    signer: signerFromEnv(env),
    baseRpcUrl: requireVar(env, "BASE_RPC_URL"),
    baseSepoliaRpcUrl: allowTestnetFromEnv(env)
      ? requireVar(env, "BASE_SEPOLIA_RPC_URL")
      : undefined,
  };
}

/** Read the signing key, exactly one of the two kinds. Errors never repeat the key. */
function signerFromEnv(env: NodeJS.ProcessEnv): SignerSource {
  const keyId = optionalVar(env, "FACILITATOR_KMS_KEY_ID");
  const key = optionalVar(env, "FACILITATOR_PRIVATE_KEY");
  if (keyId !== undefined && key !== undefined) {
    throw AppError.invalidConfig(
      "FACILITATOR_KMS_KEY_ID and FACILITATOR_PRIVATE_KEY are both set; set exactly one",
    );
  }
  if (keyId !== undefined) {
    return { kind: "kms", keyId };
  }
  if (key === undefined) {
    throw AppError.missingConfig("FACILITATOR_KMS_KEY_ID or FACILITATOR_PRIVATE_KEY");
  }
  if (!isPrivateKey(key)) {
    throw AppError.invalidConfig("FACILITATOR_PRIVATE_KEY: expected 0x and 64 hex digits");
  }
  return { kind: "privateKey", key };
}

/** Whether `value` is a 32 byte secp256k1 private key in hex. */
function isPrivateKey(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
