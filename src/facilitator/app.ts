/**
 * The facilitator's HTTP interface, in the shapes the x402 SDK's
 * `HTTPFacilitatorClient` sends and reads, so a resource server talks to it
 * with no client code of its own.
 */

import type { x402Facilitator } from "@x402/core/facilitator";
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema, z } from "@x402/core/schemas";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { Hono } from "hono";
import { describe, emptyBody, jsonError } from "../error.js";
import { log } from "../log.js";

/** The part of the facilitator the routes call. */
export type Service = Pick<x402Facilitator, "getSupported" | "verify" | "settle">;

/** The body of a verify or settle request. Only x402 V2 is registered. */
const PaymentRequest = z.object({
  paymentPayload: PaymentPayloadV2Schema,
  paymentRequirements: PaymentRequirementsV2Schema,
});

/**
 * Build the HTTP application over `service`.
 *
 * A refusal is an answer, not an error: an invalid payment or a failed
 * settlement comes back as `200` with the verdict in the body. `400` means the
 * request could not be read, and `500` means the facilitator could not decide.
 */
export function facilitatorApp(service: Service): Hono {
  const hono = new Hono();

  const routes = [
    { path: "/health", methods: ["GET", "HEAD"], answer: () => emptyBody(200) },
    {
      path: "/supported",
      methods: ["GET", "HEAD"],
      answer: () => Response.json(service.getSupported()),
    },
    ...(["verify", "settle"] as const).map((step) => ({
      path: `/${step}`,
      methods: ["POST"],
      answer: (request: Request) => decide(service, step, request),
    })),
  ];
  for (const { path, methods, answer } of routes) {
    hono.on(methods, path, (c) => answer(c.req.raw));
    // Registered after the served methods, so it answers only the others.
    hono.all(path, () => emptyBody(405, { allow: methods.join(",") }));
  }

  hono.notFound(() => emptyBody(404));

  return hono;
}

/** Read a verify or settle request and answer with the facilitator's verdict. */
async function decide(
  service: Service,
  step: "verify" | "settle",
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "request body is not JSON");
  }
  const parsed = PaymentRequest.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "request body is not an x402 V2 payment and its requirements");
  }
  // The SDK's schemas and its types describe the same shape, but the checker
  // reads their optional fields differently, so the checked body is cast.
  const { paymentPayload, paymentRequirements } = parsed.data;
  try {
    return Response.json(
      await service[step](
        paymentPayload as PaymentPayload,
        paymentRequirements as PaymentRequirements,
      ),
    );
  } catch (err) {
    log.error(`facilitator ${step} failed: ${describe(err)}`);
    return jsonError(500, `${step} failed`);
  }
}
