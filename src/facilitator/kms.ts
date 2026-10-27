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
 * so those refuse, and no bug elsewhere can make this key sign a permit.
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
 * Sign a 32 byte hash with the KMS key. KMS answers in DER, may pick either of
 * the two valid `s` values where Ethereum accepts only the lower, and leaves out
 * the recovery bit, which is found by recovering each candidate against the
 * key's own address.
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
  const { r, s } = Secp256k1.noble.Signature.fromDER(der).normalizeS();
  const parts = { r: numberToHex(r, { size: 32 }), s: numberToHex(s, { size: 32 }) };
  for (const yParity of [0, 1] as const) {
    const candidate = { ...parts, yParity };
    if (isAddressEqual(await recoverAddress({ hash, signature: candidate }), address)) {
      return candidate;
    }
  }
  throw new Error("kms signature does not recover to the key's address");
}
