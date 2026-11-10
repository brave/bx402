/** Settings shared by every AWS client this repository builds. */

import { NodeHttpHandler } from "@smithy/node-http-handler";

/**
 * A request handler that gives up on a connection or a response after
 * `timeoutMs`, so a stalled AWS endpoint cannot hang whoever is waiting on it.
 */
export function awsRequestHandler(timeoutMs: number): NodeHttpHandler {
  return new NodeHttpHandler({ connectionTimeout: timeoutMs, requestTimeout: timeoutMs });
}
