/**
 * The claim store a replica starts with: chosen by configuration, and proven
 * to work before any traffic.
 */

import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { awsRequestHandler } from "../aws.js";
import { DynamoDbClaimStore } from "./dynamodb.js";
import { MemoryClaimStore } from "./memory.js";
import type { ClaimStore } from "./store.js";

/**
 * How long the startup probe may take. Kept generous because the first call also
 * resolves credentials.
 */
const STARTUP_TIMEOUT_MS = 10_000;

/** The key the startup probe touches. No claim is ever recorded under it. */
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
 * - table set: a write and a delete of `PROBE_KEY`, which prove credentials,
 *   the table, its region, and both permissions claims need. Any failure aborts
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

/**
 * The probe, split out so tests can hand in a client over a mock table.
 *
 * The write carries a condition no item can meet, so it never lands. DynamoDB
 * checks permissions before conditions, so its refused condition proves the
 * write was allowed, while a denied write fails like any other error, and the
 * delete beside it has nothing to wait for. It is shaped like a claim's write,
 * so a policy that refuses anything a claim sends stops startup rather than
 * every payment.
 */
export async function initWith(client: DynamoDBClient, table: string): Promise<ClaimStore> {
  const options = { abortSignal: AbortSignal.timeout(STARTUP_TIMEOUT_MS) };
  try {
    await Promise.all([
      client
        .send(
          new PutItemCommand({
            TableName: table,
            Item: { pk: { S: PROBE_KEY }, holder: { S: PROBE_KEY }, expiresAt: { N: "0" } },
            ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          }),
          options,
        )
        .catch((err: unknown) => {
          if (!(err instanceof ConditionalCheckFailedException)) {
            throw err;
          }
        }),
      client.send(
        new DeleteItemCommand({ TableName: table, Key: { pk: { S: PROBE_KEY } } }),
        options,
      ),
    ]);
  } catch (err) {
    throw new Error(`replay claim table probe failed for ${table}`, { cause: err });
  }
  return new DynamoDbClaimStore(client, table);
}
