/**
 * Readers for environment variables, shared by every program this image runs.
 */

import { AppError } from "./error.js";

/** Read an optional environment variable, treating unset and empty alike. */
export function optionalVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Read a required environment variable, or fail startup naming it. */
export function requireVar(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined) {
    throw AppError.missingConfig(name);
  }
  return value;
}

/**
 * Read `ALLOW_TESTNET`: only `true` permits testnet networks. One reader for
 * every program, so they can never disagree on whether faucet money is accepted.
 */
export function allowTestnetFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.ALLOW_TESTNET === "true";
}
