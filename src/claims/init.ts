/**
 * The claim store a replica starts with: chosen by configuration, and proven
 * to work before any traffic.
 */

import { DeleteItemCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { awsRequestHandler } from "../aws.js";
import { DynamoDbClaimStore } from "./dynamodb.js";
import { MemoryClaimStore } from "./memory.js";
import type { ClaimStore } from "./store.js";

/**
 * How long the startup probe may take. Kept generous because the first call also
 * resolves credentials.
 */
const STARTUP_TIMEOUT_MS = 10_000;

/** The key the startup probe deletes. No claim is ever recorded under it. */
export const PROBE_KEY = "probe:startup";

/** Outcome of `initClaimStore`, for the startup log line. */
export type ClaimsStatus = { shared: true; table: string } | { shared: false };

/** The startup log line for a claim store status. */
export function claimsStatusLine(status: ClaimsStatus): string {
  return status.shared
    ? `✓ shared (table=${status.table})`
    : "✗ this process only (REPLAY_CLAIMS_TABLE_ID not set)";
}

/**
 * The claim store the configuration asks for, proven to work before any traffic.
 *
 * - table unset: claims stay in this process
 * - table set: one delete of `PROBE_KEY`, which proves credentials, the table,
 *   and its region with the same permission a release needs. Any failure aborts
 *   startup, so a replica never serves with claims the others cannot see.
 */
export async function initClaimStore(
  table: string | undefined,
): Promise<{ claims: ClaimStore; status: ClaimsStatus }> {
  if (table === undefined) {
    return { claims: new MemoryClaimStore(), status: { shared: false } };
  }
  const region = tableRegion(table);
  const client = new DynamoDBClient({
    ...(region === undefined ? {} : { region }),
    requestHandler: awsRequestHandler(STARTUP_TIMEOUT_MS),
  });
  return { claims: await initWith(client, table), status: { shared: true, table } };
}

/**
 * The region of a table named by ARN, which is where the table lives whatever
 * the pod's own region is. `undefined` for a plain table name, which the
 * client looks up in the pod's region.
 */
function tableRegion(table: string): string | undefined {
  const [prefix, , service, region] = table.split(":");
  return prefix === "arn" && service === "dynamodb" && region ? region : undefined;
}

/** The probe, split out so tests can hand in a client over a mock table. */
export async function initWith(client: DynamoDBClient, table: string): Promise<ClaimStore> {
  try {
    await client.send(new DeleteItemCommand({ TableName: table, Key: { pk: { S: PROBE_KEY } } }), {
      abortSignal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`replay claim table probe failed for ${table}`, { cause: err });
  }
  return new DynamoDbClaimStore(client, table);
}
