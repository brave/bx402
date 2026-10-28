import { KMSClient } from "@aws-sdk/client-kms";
import { serve } from "@hono/node-server";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadDotEnv } from "../env.js";
import { describe } from "../error.js";
import { exitAfterLogs, initLogging, log } from "../log.js";
import { VERSION } from "../version.js";
import { facilitatorApp } from "./app.js";
import { facilitatorConfigFromEnv, type SignerSource } from "./config.js";
import { checkNetworks, facilitator } from "./core.js";
import { kmsAccount } from "./kms.js";

/** How long one KMS call may take, so a stalled connection cannot hang a settlement. */
const KMS_TIMEOUT_MS = 10_000;

/**
 * Boot the facilitator: load configuration, check every network, and serve
 * until shutdown. Every startup failure leaves through a rejected promise to the
 * single exit site below.
 */
async function run(): Promise<void> {
  loadDotEnv();
  initLogging();

  log.info(`x402 facilitator v${VERSION}`);

  const config = facilitatorConfigFromEnv();
  const account = await signer(config.signer);
  log.info(`signer: ${account.address} (${config.signer.kind})`);
  // Only the chain names: an RPC URL may carry a provider key.
  log.info(`networks: ${config.networks.map(({ chain }) => chain.name).join(", ")}`);

  await checkNetworks(account.address, config.networks);

  const hono = facilitatorApp(facilitator(account, config.networks));
  const server = serve({ fetch: hono.fetch, hostname: "0.0.0.0", port: config.port }, (address) => {
    log.info(`listening on ${address.address}:${address.port}`);
  });

  // Serve until the process is stopped; a failure on the listener, a port
  // already in use above all, leaves through this promise to the single exit
  // site below instead of crashing on an unhandled error event.
  await new Promise<never>((_resolve, reject) => {
    server.on("error", reject);
  });
}

/** The account that signs settlements, from the configured source. */
async function signer(source: SignerSource): Promise<LocalAccount> {
  if (source.kind === "privateKey") {
    return privateKeyToAccount(source.key);
  }
  const client = new KMSClient({
    requestHandler: new NodeHttpHandler({
      connectionTimeout: KMS_TIMEOUT_MS,
      requestTimeout: KMS_TIMEOUT_MS,
    }),
  });
  return kmsAccount(client, source.keyId);
}

run().catch((err: unknown) => {
  log.error(describe(err));
  exitAfterLogs(1);
});
