/**
 * The x402 facilitator: verifies exact payments and settles them on chain,
 * paying the gas from its own account.
 */

import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import {
  type Address,
  BaseError,
  type Chain,
  createNonceManager,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  keccak256,
  type LocalAccount,
  publicActions,
  type Transport,
  type VerifyTypedDataParameters,
  withTimeout,
} from "viem";
import { jsonRpc } from "viem/nonce";
import { AppError, describe } from "../error.js";
import { networkId, type SettlementNetwork } from "./config.js";

/**
 * A facilitator that settles exact payments on `networks`, signing and paying
 * gas with `account`. Only x402 V2 is registered.
 */
export function facilitator(account: LocalAccount, networks: SettlementNetwork[]): x402Facilitator {
  const service = new x402Facilitator();
  for (const { chain, rpcUrl } of networks) {
    const signer = settlementSigner(account, chain, http(rpcUrl));
    // Settling re-runs the transfer as a simulation first, so a payment that
    // would revert, such as one whose authorization was already used, is
    // refused before it costs gas.
    service.register(networkId(chain), new ExactEvmScheme(signer, { simulateInSettle: true }));
  }
  return service;
}

/**
 * How long a settlement waits for its receipt. It must end well before a
 * resource server's own request gives up (90 seconds in the x402 SDK's HTTP
 * client), so the payment gets an answer, `settlement_pending` with the
 * transaction hash, instead of the resource server timing out while the
 * transaction may still go through.
 */
export const RECEIPT_TIMEOUT_MS = 60_000;

/** The signer the exact scheme settles through on `chain`, sending from `account`. */
export function settlementSigner(account: LocalAccount, chain: Chain, transport: Transport) {
  const client = settlementClient(account, chain, transport);
  return toFacilitatorEvmSigner(
    {
      address: account.address,
      readContract: (args) => client.readContract(args),
      // viem types this as a union over how the block is picked, and the
      // checker cannot match the SDK's plain object to the case that picks none.
      verifyTypedData: (args) => client.verifyTypedData(args as VerifyTypedDataParameters),
      writeContract: (args) => client.writeContract(args),
      sendTransaction: (args) => client.sendTransaction(args),
      waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
      getCode: (args) => client.getCode(args),
    },
    { confirmationTimeoutMs: RECEIPT_TIMEOUT_MS },
  );
}

/**
 * The client that sends settlements on `chain` from `account`. It keeps its own
 * nonce count, so settlements in flight at the same time each get the next
 * nonce instead of all reading the same one from the chain. A send that fails
 * resets the count, so it leaves no gap.
 */
export function settlementClient(account: LocalAccount, chain: Chain, transport: Transport) {
  const sender = { ...account, nonceManager: createNonceManager({ source: jsonRpc() }) };
  return createWalletClient({
    account: sender,
    chain,
    transport: knownBroadcast(transport),
  }).extend(publicActions);
}

/**
 * Wrap `transport` so a broadcast that errors still counts as sent when the node
 * already has the transaction. The node can accept a transaction and its answer
 * still be lost, and the retry then fails with "already known" or "nonce too
 * low", or every attempt times out. The node is asked for the transaction by its
 * hash, and when it has it, pending or mined, the hash is returned as a normal
 * send would. Otherwise, or when the lookup fails too, the original error stands.
 */
function knownBroadcast(transport: Transport): Transport {
  return (params) => {
    const inner = transport(params);
    const request = (async (args, options) => {
      try {
        return await inner.request(args, options);
      } catch (err) {
        if (args.method !== "eth_sendRawTransaction") {
          throw err;
        }
        const hash = keccak256((args.params as [Hex])[0]);
        const known = await inner
          .request({ method: "eth_getTransactionByHash", params: [hash] })
          .catch(() => null);
        if (!known) {
          throw err;
        }
        return hash;
      }
    }) as typeof inner.request;
    return { ...inner, request };
  };
}

/**
 * How long one network's startup check may take. Without it, an RPC that
 * accepts the connection and never answers holds startup for about 40 seconds
 * through viem's own timeouts and retries.
 */
export const CHECK_TIMEOUT_MS = 10_000;

/**
 * Check every network before serving: its RPC must answer for the chain it is
 * configured as, and `address` must hold some ETH there to pay gas. Any failure,
 * or no answer within `CHECK_TIMEOUT_MS`, stops startup. Errors name the chain
 * and never the RPC URL, which may carry a provider key.
 */
export async function checkNetworks(
  address: Address,
  networks: SettlementNetwork[],
  transport: (rpcUrl: string) => Transport = http,
): Promise<void> {
  await Promise.all(
    networks.map(async ({ chain, rpcUrl }) => {
      const client = createPublicClient({ chain, transport: transport(rpcUrl) });
      const [chainId, balance] = await withTimeout(
        () => Promise.all([client.getChainId(), client.getBalance({ address })]),
        {
          timeout: CHECK_TIMEOUT_MS,
          errorInstance: new Error(`no answer in ${CHECK_TIMEOUT_MS / 1000} seconds`),
        },
      ).catch((err: unknown) => {
        // A viem error's full message includes the URL; its short message does not.
        const reason = err instanceof BaseError ? err.shortMessage : describe(err);
        throw AppError.invalidConfig(`${chain.name} RPC: ${reason}`);
      });
      if (chainId !== chain.id) {
        throw AppError.invalidConfig(
          `${chain.name} RPC serves chain ${chainId}, expected ${chain.id}`,
        );
      }
      if (balance === 0n) {
        throw AppError.invalidConfig(`signer ${address} holds no ETH on ${chain.name}`);
      }
    }),
  );
}
