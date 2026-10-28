/**
 * An EVM account whose private key lives in AWS KMS. Every signature is a
 * `kms:Sign` call, so the key never reaches this process.
 */

import { createPublicKey } from "node:crypto";
import { GetPublicKeyCommand, type KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { Secp256k1 } from "ox";
import {
  type Address,
  bytesToHex,
  type Hex,
  hexToBytes,
  isAddressEqual,
  keccak256,
  type LocalAccount,
  numberToHex,
  recoverAddress,
  serializeTransaction,
} from "viem";
import { publicKeyToAddress, toAccount } from "viem/accounts";
import { AppError, describe } from "../error.js";

/**
 * The account for KMS key `keyId`. The key must be a secp256k1 signing key;
 * anything else, or a key the caller cannot read, stops startup.
 *
 * It signs transactions only. A facilitator never signs messages or typed data,
 * so those refuse, and no bug elsewhere can make this key sign a permit. Blob
 * transactions (EIP-4844) refuse too: a facilitator never sends one, and they
 * would need their blobs left out of the hash that gets signed.
 */
export async function kmsAccount(client: KMSClient, keyId: string): Promise<LocalAccount> {
  let address: Address;
  try {
    const { PublicKey } = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    address = publicKeyToAddress(uncompressedPoint(PublicKey));
  } catch (err) {
    throw AppError.invalidConfig(`FACILITATOR_KMS_KEY_ID: ${describe(err)}`);
  }
  const transactionsOnly = async (): Promise<never> => {
    throw new Error("the facilitator key signs transactions only");
  };
  return toAccount({
    address,
    signMessage: transactionsOnly,
    signTypedData: transactionsOnly,
    signTransaction: async (transaction, options) => {
      if (transaction.type === "eip4844") {
        throw new Error("the facilitator key does not sign blob transactions");
      }
      const serializer = options?.serializer ?? serializeTransaction;
      const hash = keccak256(await serializer(transaction));
      return serializer(transaction, await signHash(client, keyId, address, hash));
    },
  });
}

/**
 * The uncompressed point, `0x04` then x and y, out of the DER
 * SubjectPublicKeyInfo KMS returns. Node parses the encoding; a key on any
 * curve but secp256k1 is refused.
 */
function uncompressedPoint(spki: Uint8Array | undefined): Hex {
  const key = createPublicKey({ key: spki ?? new Uint8Array(), format: "der", type: "spki" });
  if (key.asymmetricKeyDetails?.namedCurve !== "secp256k1") {
    throw new Error("public key is not on secp256k1");
  }
  return bytesToHex(key.export({ format: "raw-public" }));
}

/**
 * Sign a 32 byte hash with the KMS key, and re-encode the answer in the form
 * Ethereum accepts. Nothing here changes what was signed.
 */
async function signHash(client: KMSClient, keyId: string, address: Address, hash: Hex) {
  const { Signature: der } = await client.send(
    new SignCommand({
      KeyId: keyId,
      Message: hexToBytes(hash),
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    }),
  );
  if (der === undefined) {
    throw new Error("kms returned no signature");
  }

  // KMS answers in DER, which holds the two numbers r and s. Every signature has
  // a twin, (r, s) and (r, n - s), and both are valid for the same key and hash.
  // KMS may return either, but Ethereum only accepts the one with the smaller s
  // (EIP-2), so pick that one.
  const { r, s } = Secp256k1.noble.Signature.fromDER(der).normalizeS();

  // Ethereum wants r and s as 32 bytes each, left padded with zeros.
  const parts = { r: numberToHex(r, { size: 32 }), s: numberToHex(s, { size: 32 }) };

  // Ethereum also wants a recovery bit, which says which of two possible public
  // keys made the signature. DER has no room for it, so try both values and keep
  // the one that recovers our own address. If neither does, KMS signed with
  // some other key, and nothing is returned.
  for (const yParity of [0, 1] as const) {
    const candidate = { ...parts, yParity };
    if (isAddressEqual(await recoverAddress({ hash, signature: candidate }), address)) {
      return candidate;
    }
  }
  throw new Error("kms signature does not recover to the key's address");
}
