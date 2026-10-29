/**
 * Serving an app until the process is asked to stop, shared by every program
 * this image runs.
 */

import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { log } from "./log.js";

/**
 * Serve `hono` on `port` until SIGTERM or SIGINT, then stop taking requests and
 * let the ones in flight run to the end, so a restart never cuts a payment off
 * between settling it and answering. The pod's grace period must outlast the
 * longest request.
 *
 * Resolves once the last request has finished. A failure on the listener, a
 * port already in use above all, rejects instead of crashing on an unhandled
 * error event.
 */
export function serveUntilStopped(hono: Hono, port: number): Promise<void> {
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
      port,
    },
    (address) => {
      log.info(`listening on ${address.address}:${address.port}`);
    },
  );

  return new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    const stop = (signal: NodeJS.Signals) => {
      log.info(`${signal}: finishing requests in flight`);
      stopping = true;
      server.close((err) => (err === undefined ? resolve() : reject(err)));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}
