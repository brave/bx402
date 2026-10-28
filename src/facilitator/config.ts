/**
 * Runtime configuration for the x402 facilitator, read from the environment at
 * startup.
 */

import type { Chain } from "viem";
import { base, baseSepolia } from "viem/chains";
import { allowTestnetFromEnv, optionalVar, requireVar } from "../env.js";
import { AppError } from "../error.js";

/**
 * Where the key that pays gas and submits settlements lives: in AWS KMS, where
 * it never reaches this process, or in the environment as a raw private key.
 */
export type SignerSource =
  | { kind: "kms"; keyId: string }
  | { kind: "privateKey"; key: `0x${string}` };

/** A network to settle on, and the RPC endpoint the facilitator reaches its chain through. */
export interface SettlementNetwork {
  chain: Chain;
  rpcUrl: string;
}

/** Runtime configuration for the facilitator, read once from the environment at startup. */
export interface FacilitatorConfig {
  /** The key that signs settlement transactions. */
  signer: SignerSource;
  /**
   * The networks to settle on: Base mainnet, and Base Sepolia when testnets are
   * allowed. Never empty.
   */
  networks: SettlementNetwork[];
  /** The port serving the HTTP API. */
  port: number;
}

/** The port the HTTP API listens on when `FACILITATOR_PORT` is unset. */
const DEFAULT_PORT = 8080;

/**
 * Read configuration from the process environment:
 *
 * - `FACILITATOR_KMS_KEY_ID`: AWS KMS key that signs settlements.
 * - `FACILITATOR_PRIVATE_KEY`: a raw private key instead. Exactly one of the two
 *   must be set.
 * - `BASE_RPC_URL` (required without `ALLOW_TESTNET`): Base mainnet RPC
 *   endpoint. With `ALLOW_TESTNET` it is optional, and Base mainnet is settled
 *   on only when it is set, so a testnet run needs no mainnet funds.
 * - `BASE_SEPOLIA_RPC_URL` (required with `ALLOW_TESTNET`): Base Sepolia RPC endpoint.
 * - `ALLOW_TESTNET` (optional): `true` also settles on Base Sepolia.
 * - `FACILITATOR_PORT` (optional): port for the HTTP API, 8080 by default. `0`
 *   picks a free one.
 */
export function facilitatorConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const signer = signerFromEnv(env);
  const testnet = allowTestnetFromEnv(env);
  const baseRpcUrl = testnet ? optionalVar(env, "BASE_RPC_URL") : requireVar(env, "BASE_RPC_URL");
  return {
    signer,
    networks: [
      ...(baseRpcUrl === undefined ? [] : [{ chain: base, rpcUrl: baseRpcUrl }]),
      ...(testnet ? [{ chain: baseSepolia, rpcUrl: requireVar(env, "BASE_SEPOLIA_RPC_URL") }] : []),
    ],
    port: portFromEnv(env),
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

/** Read the listening port, the default when unset. */
function portFromEnv(env: NodeJS.ProcessEnv): number {
  const value = optionalVar(env, "FACILITATOR_PORT");
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65_535) {
    throw AppError.invalidConfig("FACILITATOR_PORT: expected a port number");
  }
  return port;
}

/** Whether `value` is a 32 byte secp256k1 private key in hex. */
function isPrivateKey(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
