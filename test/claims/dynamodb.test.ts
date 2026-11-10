import { DeleteItemCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamoDbClaimStore } from "../../src/claims/dynamodb.js";
import { ClaimStoreError } from "../../src/claims/store.js";
import { conditionFailed } from "../support.js";

const TABLE = "bx402-replay-claims";

/** Every client this file builds answers from this dynamodb. */
const dynamodb = mockClient(DynamoDBClient);

/** A claim store over the mock table. */
function mockStore(): DynamoDbClaimStore {
  return new DynamoDbClaimStore(new DynamoDBClient({}), TABLE);
}

afterEach(() => {
  dynamodb.reset();
});

describe("dynamodb claims", () => {
  it("a_claim_is_one_conditional_put_held_by_the_returned_token", async () => {
    const store = mockStore();
    dynamodb.on(PutItemCommand).resolves({});

    const token = await store.tryClaim("key", 1_700_000_000_500);

    const [call] = dynamodb.commandCalls(PutItemCommand);
    expect(call?.args[0].input).toMatchObject({
      TableName: TABLE,
      Item: {
        pk: { S: "key" },
        holder: { S: token },
        // Rounded up, so the claim never lapses before it was asked to.
        expiresAt: { N: "1700000001" },
      },
      ConditionExpression: "attribute_not_exists(#pk) OR #expiresAt <= :now",
    });
  });

  it("a_key_whose_claim_holds_is_refused", async () => {
    const store = mockStore();
    dynamodb.on(PutItemCommand).rejects(conditionFailed("someone else"));

    expect(await store.tryClaim("key", Date.now() + 60_000)).toBeUndefined();
    const [call] = dynamodb.commandCalls(PutItemCommand);
    expect(call?.args[0].input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
  });

  it("a_retried_write_that_finds_its_own_claim_holds_the_key", async () => {
    // The first attempt was written but its answer was lost, so the retry is
    // refused by the very claim this call made.
    const store = mockStore();
    dynamodb.on(PutItemCommand).callsFake((input: { Item: { holder: { S: string } } }) => {
      throw conditionFailed(input.Item.holder.S);
    });

    const token = await store.tryClaim("key", Date.now() + 60_000);

    expect(token).toBeDefined();
    expect(token).toBe(dynamodb.commandCalls(PutItemCommand)[0]?.args[0].input.Item?.holder?.S);
  });

  it("a_table_that_cannot_answer_rejects_rather_than_claiming", async () => {
    const store = mockStore();
    const cause = new Error("AccessDeniedException");
    dynamodb.on(PutItemCommand).rejects(cause);

    const claimed = store.tryClaim("key", Date.now() + 60_000);

    await expect(claimed).rejects.toBeInstanceOf(ClaimStoreError);
    await expect(claimed).rejects.toHaveProperty("cause", cause);
  });

  it("a_write_that_lands_after_the_wait_is_removed_by_its_own_token", async () => {
    // The answer never arrived, so whether the claim landed is unknown. Only a
    // claim holding this call's token is deleted, never someone else's.
    const store = mockStore();
    dynamodb.on(PutItemCommand).rejects(new Error("TimeoutError"));
    dynamodb.on(DeleteItemCommand).resolves({});

    await expect(store.tryClaim("key", Date.now() + 60_000)).rejects.toBeInstanceOf(
      ClaimStoreError,
    );

    await vi.waitFor(() => expect(dynamodb.commandCalls(DeleteItemCommand)).toHaveLength(1));
    const token = dynamodb.commandCalls(PutItemCommand)[0]?.args[0].input.Item?.holder?.S;
    expect(dynamodb.commandCalls(DeleteItemCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: { S: "key" } },
      ConditionExpression: "#holder = :holder",
      ExpressionAttributeValues: { ":holder": { S: token } },
    });
  });

  it("a_release_deletes_only_the_holders_claim", async () => {
    const store = mockStore();
    dynamodb.on(DeleteItemCommand).resolves({});

    await store.release("key", "token");

    const [call] = dynamodb.commandCalls(DeleteItemCommand);
    expect(call?.args[0].input).toMatchObject({
      TableName: TABLE,
      Key: { pk: { S: "key" } },
      ConditionExpression: "#holder = :holder",
      ExpressionAttributeValues: { ":holder": { S: "token" } },
    });
  });

  it("a_drop_deletes_the_key_whoever_holds_it", async () => {
    const store = mockStore();
    dynamodb.on(DeleteItemCommand).resolves({});

    await store.drop("key");

    const [call] = dynamodb.commandCalls(DeleteItemCommand);
    expect(call?.args[0].input).toEqual({ TableName: TABLE, Key: { pk: { S: "key" } } });
  });

  it("a_release_never_rejects", async () => {
    // A claim taken over by another holder, and a table that cannot answer,
    // both leave the release a no-op the caller never has to handle.
    for (const failure of [conditionFailed(), new Error("ServiceUnavailable")]) {
      const store = mockStore();
      dynamodb.on(DeleteItemCommand).rejects(failure);
      await expect(store.release("key", "token")).resolves.toBeUndefined();
      dynamodb.reset();
    }
  });
});
