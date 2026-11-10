/**
 * Claims recorded in a DynamoDB table, shared by every pod that points at it.
 *
 * One item per claimed key:
 *
 * - `pk` (string): the replay key, the table's partition key
 * - `holder` (string): the token of whoever holds the claim
 * - `expiresAt` (number): when the claim lapses, in epoch seconds, also the
 *   table's TTL attribute
 *
 * DynamoDB removes expired items lazily, hours after they lapse, so a claim
 * compares `expiresAt` itself and never relies on a lapsed item being gone.
 * Attribute names go through placeholders, which keeps every expression clear
 * of DynamoDB's reserved words.
 */

import { randomUUID } from "node:crypto";
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  type DeleteItemCommandInput,
  type DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { describe } from "../error.js";
import { log } from "../log.js";
import { type ClaimStore, ClaimStoreError, type ClaimToken } from "./store.js";

/**
 * How long one table call may take on the request path. A payment waits on its
 * claim, so a stalled table answers with a refusal rather than a hung request.
 */
const CALL_TIMEOUT_MS = 2_000;

export class DynamoDbClaimStore implements ClaimStore {
  /** `table` is a table name or, for a table in another account, its ARN. */
  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
  ) {}

  /**
   * One conditional write: it succeeds only when no claim on the key exists or
   * the existing one has lapsed, and DynamoDB applies it atomically, so two
   * pods racing for a key cannot both win. The expiry is rounded up to a whole
   * second, so a claim never lapses earlier than asked.
   *
   * The client retries a write whose answer was lost, and that retry finds the
   * claim its first attempt already wrote. A refusal therefore hands back the
   * claim in the way, and one holding this call's own token is this call's.
   *
   * A write can also land after this call gave up waiting on it. A release is
   * sent in the background so the payer is not locked out of a retry by a
   * claim nobody holds, though a write that lands after that release still
   * holds its key until it lapses.
   */
  async tryClaim(key: string, expires: number): Promise<ClaimToken | undefined> {
    const token = randomUUID();
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.table,
          Item: {
            pk: { S: key },
            holder: { S: token },
            expiresAt: { N: String(Math.ceil(expires / 1000)) },
          },
          ConditionExpression: "attribute_not_exists(#pk) OR #expiresAt <= :now",
          ExpressionAttributeNames: { "#pk": "pk", "#expiresAt": "expiresAt" },
          ExpressionAttributeValues: { ":now": { N: String(Math.floor(Date.now() / 1000)) } },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
        { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return err.Item?.holder?.S === token ? token : undefined;
      }
      void this.release(key, token);
      throw new ClaimStoreError(err);
    }
    return token;
  }

  /**
   * A delete conditioned on the holder, so a caller whose claim lapsed and was
   * taken over removes nothing.
   */
  async release(key: string, token: ClaimToken): Promise<void> {
    await this.delete({
      TableName: this.table,
      Key: { pk: { S: key } },
      ConditionExpression: "#holder = :holder",
      ExpressionAttributeNames: { "#holder": "holder" },
      ExpressionAttributeValues: { ":holder": { S: token } },
    });
  }

  async drop(key: string): Promise<void> {
    await this.delete({ TableName: this.table, Key: { pk: { S: key } } });
  }

  /**
   * Run one delete, logging and swallowing any failure: the claim then holds
   * its key until it lapses. A failed holder condition means the claim was
   * already taken over, so there is nothing to log.
   */
  private async delete(input: DeleteItemCommandInput): Promise<void> {
    try {
      await this.client.send(new DeleteItemCommand(input), {
        abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return;
      }
      log.error(`replay claim could not be released: ${describe(err)}`);
    }
  }
}
