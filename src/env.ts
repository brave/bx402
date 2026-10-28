/**
 * Readers for environment variables, shared by every program this image runs.
 */

import { AppError, describe } from "./error.js";

/**
 * Load a local `.env` for development. Real environment variables still take
 * precedence, and an absent file is not an error. A `.env` that is there but
 * cannot be read stops startup, so it never looks like missing settings.
 */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (err: unknown) {
    // No `.env` beside the process, which is the normal case in production.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw AppError.invalidConfig(`.env: ${describe(err)}`);
    }
  }
}

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
