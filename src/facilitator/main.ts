import { KMSClient } from "@aws-sdk/client-kms";
import { serve } from "@hono/node-server";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadDotEnv } from "../env.js";
import { describe } from "../error.js";
import { exitAfterLogs, initLogging, log } from "../log.js";
import { serveMetrics } from "../metrics.js";
import { VERSION } from "../version.js";
import { facilitatorApp } from "./app.js";
import { facilitatorConfigFromEnv, type SignerSource } from "./config.js";
import { checkNetworks, facilitator } from "./core.js";
import { kmsAccount } from "./kms.js";
import { FacilitatorMetrics, measured } from "./metrics.js";

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

  const metrics = new FacilitatorMetrics(config.networks);
  const hono = facilitatorApp(measured(facilitator(account, config.networks), metrics));
  let stopping = false;
  const server = serve(
    {
      // Once stopping, every answer closes its connection, so a caller that
      // keeps connections open sends its next request elsewhere instead of
      // holding the stop open.
      fetch: async (request, env) => {
        const response = await hono.fetch(request, env);
        if (stopping) {
          response.headers.set("connection", "close");
        }
        return response;
      },
      hostname: "0.0.0.0",
      port: config.port,
    },
    (address) => {
      log.info(`listening on ${address.address}:${address.port}`);
    },
  );

  // Serve until asked to stop. A failure on either listener, a port already in
  // use above all, leaves through this promise to the single exit site below
  // instead of crashing on an unhandled error event. On SIGTERM or SIGINT the
  // listener stops taking requests and the ones in flight run to the end, so a
  // restart never cuts a settlement off between sending its transaction and
  // answering. The pod's grace period must outlast the wait for a receipt.
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      const stop = (signal: NodeJS.Signals) => {
        log.info(`${signal}: finishing requests in flight`);
        stopping = true;
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    }),
    serveMetrics(metrics),
  ]);
  log.info("stopped");
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

run().then(
  // Exit once the logs are out rather than wait on idle sockets, such as the
  // KMS client's pool.
  () => exitAfterLogs(0),
  (err: unknown) => {
    log.error(describe(err));
    exitAfterLogs(1);
  },
);
