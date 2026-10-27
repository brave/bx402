import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { mockClient } from "aws-sdk-client-mock";
import { Secp256k1, Signature } from "ox";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { afterEach, describe, expect, it } from "vitest";
import { kmsAccount } from "../../src/facilitator/kms.js";

const kms = mockClient(KMSClient);

/** The key the fake KMS holds, and viem's own account over it to compare with. */
const KEY = `0x${"42".repeat(32)}` as const;
const local = privateKeyToAccount(KEY);

const transaction = {
  chainId: baseSepolia.id,
  to: "0x000000000000000000000000000000000000dEaD",
  value: 1n,
  nonce: 7,
  gas: 21_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
} as const;

/** The public key of `key` in the DER form KMS returns. */
function spkiOf(key: Hex): Buffer {
  const point = hexToBytes(privateKeyToAccount(key).publicKey);
  return createPublicKey({
    key: point,
    format: "raw-public",
    asymmetricKeyType: "ec",
    namedCurve: "secp256k1",
  }).export({ type: "spki", format: "der" });
}

/** Answer like a KMS key holding `key`. KMS may return either valid `s`; `highS` picks the upper. */
function fakeKms(key: Hex, { highS = false } = {}): void {
  kms.on(GetPublicKeyCommand).resolves({ PublicKey: spkiOf(key) });
  kms.on(SignCommand).callsFake(({ Message }: { Message: Uint8Array }) => {
    const { r, s } = Secp256k1.sign({ payload: bytesToHex(Message), privateKey: key });
    return { Signature: Signature.toDerBytes({ r, s: highS ? Secp256k1.noble.CURVE.n - s : s }) };
  });
}

const account = () => kmsAccount(new KMSClient({}), "key-id");

afterEach(() => {
  kms.reset();
});

describe("kms account", () => {
  it("signs_transactions_exactly_as_a_local_key_would", async () => {
    fakeKms(KEY);
    const signer = await account();

    expect(signer.address).toBe(local.address);
    expect(await signer.signTransaction(transaction)).toBe(
      await local.signTransaction(transaction),
    );
  });

  it("lowers_a_high_s_signature", async () => {
    fakeKms(KEY, { highS: true });

    expect(await (await account()).signTransaction(transaction)).toBe(
      await local.signTransaction(transaction),
    );
  });

  it("refuses_to_sign_anything_but_a_transaction", async () => {
    fakeKms(KEY);
    const signer = await account();

    await expect(signer.signMessage({ message: "hi" })).rejects.toThrow(/transactions only/);
    await expect(
      signer.signTypedData({
        types: { Note: [{ name: "text", type: "string" }] },
        primaryType: "Note",
        message: { text: "hi" },
      }),
    ).rejects.toThrow(/transactions only/);
    expect(kms.commandCalls(SignCommand)).toHaveLength(0);
  });

  it("refuses_any_key_but_secp256k1_at_startup", async () => {
    const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
    const keys = {
      garbage: Uint8Array.of(1, 2, 3),
      truncated: spkiOf(KEY).subarray(1),
      "another curve": p256.export({ type: "spki", format: "der" }),
    };

    for (const [name, spki] of Object.entries(keys)) {
      kms.on(GetPublicKeyCommand).resolves({ PublicKey: spki });
      await expect(account(), name).rejects.toThrow(/FACILITATOR_KMS_KEY_ID: /);
    }
  });

  it("refuses_a_signature_from_another_key", async () => {
    fakeKms(KEY);
    const signer = await account();
    // The key behind the id changes after startup.
    fakeKms(`0x${"43".repeat(32)}`);

    await expect(signer.signTransaction(transaction)).rejects.toThrow(
      /does not recover to the key's address/,
    );
  });
});
