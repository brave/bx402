import { DeleteItemCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { DynamoDbClaimStore } from "../../src/claims/dynamodb.js";
import { claimsStatusLine, initClaimStore, initWith, PROBE_KEY } from "../../src/claims/init.js";
import { MemoryClaimStore } from "../../src/claims/memory.js";
import { conditionFailed } from "../support.js";

const TABLE = "bx402-replay-claims";

/** Every client this file builds answers from this dynamodb. */
const dynamodb = mockClient(DynamoDBClient);

afterEach(() => {
  dynamodb.reset();
});

describe("claim store startup", () => {
  it("no_table_keeps_claims_in_this_process", async () => {
    const { claims, status } = await initClaimStore(undefined);

    expect(claims).toBeInstanceOf(MemoryClaimStore);
    expect(claimsStatusLine(status)).toBe("✗ this process only (REPLAY_CLAIMS_TABLE_ID not set)");
  });

  it("a_table_named_by_arn_is_reached_in_the_arns_region", async () => {
    // The table lives in another account and region, so the pod's own region
    // would look for it in the wrong place.
    const arn = "arn:aws:dynamodb:us-west-2:687622360911:table/bx402-replay-claims";
    dynamodb.on(PutItemCommand).rejects(conditionFailed());
    dynamodb.on(DeleteItemCommand).resolves({});

    const { claims, status } = await initClaimStore(arn);

    expect(claims).toBeInstanceOf(DynamoDbClaimStore);
    expect(claimsStatusLine(status)).toBe(`✓ shared (table=${arn})`);
    const [call] = dynamodb.commandCalls(DeleteItemCommand);
    if (call === undefined) {
      throw new Error("startup probes the table");
    }
    expect(call.args[0].input.TableName).toBe(arn);
    expect(await (call.thisValue as DynamoDBClient).config.region()).toBe("us-west-2");
  });

  it("startup_probes_the_table_with_a_write_that_never_lands_and_a_delete", async () => {
    dynamodb.on(PutItemCommand).rejects(conditionFailed());
    dynamodb.on(DeleteItemCommand).resolves({});

    const claims = await initWith(new DynamoDBClient({}), TABLE);

    expect(claims).toBeInstanceOf(DynamoDbClaimStore);
    const [write] = dynamodb.commandCalls(PutItemCommand);
    expect(write?.args[0].input).toMatchObject({
      TableName: TABLE,
      Item: { pk: { S: PROBE_KEY } },
      ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#pk)",
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    });
    const [call] = dynamodb.commandCalls(DeleteItemCommand);
    expect(call?.args[0].input).toEqual({ TableName: TABLE, Key: { pk: { S: PROBE_KEY } } });
  });

  it("a_table_the_probe_cannot_reach_aborts_startup", async () => {
    // A role allowed to delete but not to write would otherwise start and
    // then fail every claim.
    for (const denied of ["write", "delete"]) {
      const cause = new Error("AccessDeniedException");
      dynamodb.on(PutItemCommand).rejects(denied === "write" ? cause : conditionFailed());
      if (denied === "delete") {
        dynamodb.on(DeleteItemCommand).rejects(cause);
      } else {
        dynamodb.on(DeleteItemCommand).resolves({});
      }

      const started = initWith(new DynamoDBClient({}), TABLE);

      await expect(started, denied).rejects.toThrow(`replay claim table probe failed for ${TABLE}`);
      await expect(started, denied).rejects.toHaveProperty("cause", cause);
      dynamodb.reset();
    }
  });
});
