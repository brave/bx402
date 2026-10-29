import { app, banner } from "./app.js";
import { configFromEnv } from "./config.js";
import { loadDotEnv } from "./env.js";
import { describe } from "./error.js";
import { exitAfterLogs, initLogging, log } from "./log.js";
import { Metrics, serveMetrics } from "./metrics.js";
import { initScreener, statusLine } from "./screener.js";
import { serveUntilStopped } from "./serve.js";

/** Port serving public traffic. */
const PORT = 8080;

/**
 * Boot the service: load configuration, wire dependencies, and serve until
 * shutdown. Every startup failure leaves through a rejected promise to the
 * single exit site below.
 */
async function run(): Promise<void> {
  loadDotEnv();
  initLogging();

  log.info(banner());

  // Built before anything that records into it.
  const metrics = new Metrics();

  const config = configFromEnv();
  log.info(`brave search api: ${config.braveSearchApiBaseUrl}`);
  log.info(
    config.x402 === undefined
      ? "x402 rail: disabled by ENABLED_RAILS"
      : `x402 facilitator: ${config.x402.facilitatorUrl}` +
          (config.x402.cdp === undefined ? "" : " (cdp credentials set)") +
          (config.x402.enableBazaar ? ", bazaar enabled" : ", bazaar disabled"),
  );
  log.info(
    config.mpp === undefined
      ? "mpp rail: disabled by ENABLED_RAILS"
      : `mpp tempo rpc: ${config.mpp.rpcUrl}`,
  );

  // A configured but unreachable bucket aborts startup, so the service never
  // serves traffic with a broken screener.
  const { screener, status } = await initScreener(config, metrics);
  log.info(`restricted address screening: ${statusLine(status)}`);

  const hono = await app(config, screener, metrics);

  // Traffic and metrics are served on separate listeners, so the public port
  // never exposes the metrics. A failure on either listener, a port already in
  // use above all, leaves through this promise to the single exit site below.
  // The metrics listener keeps serving until the process exits, so scrapes
  // still land while requests in flight finish.
  await Promise.race([serveUntilStopped(hono, PORT), serveMetrics(metrics)]);
  log.info("stopped");
}

run().then(
  // Exit once the logs are out rather than wait on the metrics listener and
  // idle sockets.
  () => exitAfterLogs(0),
  (err: unknown) => {
    log.error(describe(err));
    exitAfterLogs(1);
  },
);
