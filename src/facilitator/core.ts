/**
 * The x402 facilitator: verifies exact payments and settles them on chain,
 * paying the gas from its own account.
 */

import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import {
  type Chain,
  createNonceManager,
  createWalletClient,
  http,
  type LocalAccount,
  publicActions,
  type Transport,
  type VerifyTypedDataParameters,
} from "viem";
import { jsonRpc } from "viem/nonce";
import type { SettlementNetwork } from "./config.js";

/**
 * A facilitator that settles exact payments on `networks`, signing and paying
 * gas with `account`. Only x402 V2 is registered.
 */
export function facilitator(account: LocalAccount, networks: SettlementNetwork[]): x402Facilitator {
  const service = new x402Facilitator();
  for (const { chain, rpcUrl } of networks) {
    const client = settlementClient(account, chain, http(rpcUrl));
    const signer = toFacilitatorEvmSigner({
      address: account.address,
      readContract: (args) => client.readContract(args),
      // viem types this as a union over how the block is picked, and the
      // checker cannot match the SDK's plain object to the case that picks none.
      verifyTypedData: (args) => client.verifyTypedData(args as VerifyTypedDataParameters),
      writeContract: (args) => client.writeContract(args),
      sendTransaction: (args) => client.sendTransaction(args),
      waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
      getCode: (args) => client.getCode(args),
    });
    // Settling re-runs the transfer as a simulation first, so a payment that
    // would revert, such as one whose authorization was already used, is
    // refused before it costs gas.
    service.register(`eip155:${chain.id}`, new ExactEvmScheme(signer, { simulateInSettle: true }));
  }
  return service;
}

/**
 * The client that sends settlements on `chain` from `account`. It keeps its own
 * nonce count, so settlements in flight at the same time each get the next
 * nonce instead of all reading the same one from the chain. A send that fails
 * resets the count, so it leaves no gap.
 */
export function settlementClient(account: LocalAccount, chain: Chain, transport: Transport) {
  const sender = { ...account, nonceManager: createNonceManager({ source: jsonRpc() }) };
  return createWalletClient({ account: sender, chain, transport }).extend(publicActions);
}
