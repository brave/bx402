/**
 * Prometheus metrics for the facilitator: what it verified and settled, and how
 * long that took. They are served on their own listener, like the service's.
 */

import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  openMetricsContentType,
  Registry,
} from "@prometheus-io/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { type Address, createPublicClient, formatEther, http, type Transport } from "viem";
import { log } from "../log.js";
import { seconds } from "../metrics.js";
import { VERSION } from "../version.js";
import type { Service } from "./app.js";
import { networkId, type SettlementNetwork } from "./config.js";
import { rpcFailure } from "./core.js";

/**
 * Buckets for the time to answer, in seconds. A settlement waits for its
 * receipt, which on Base is usually a few seconds, so the steps sit there, and
 * the last one is the longest a receipt is waited for.
 */
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 15, 30, 60];

/**
 * Label for a network the facilitator does not settle on. The network comes
 * from the caller, so it cannot mint a series of its own.
 */
const OTHER = "other";

/** The SDK's reason for a `pending` settlement, which it does not export. */
const SETTLEMENT_PENDING = "settlement_pending";

/** The two requests the facilitator decides. */
type Step = "verify" | "settle";

/**
 * How a request ended. `pending` is a settlement whose transaction was sent but
 * whose receipt did not arrive in time, and `error` is one the facilitator
 * could not decide.
 */
type Outcome = "valid" | "invalid" | "settled" | "refused" | "pending" | "error";

/** Everything the facilitator records, and the registry that renders it. */
export class FacilitatorMetrics {
  // Each metric registers itself here as its initializer runs. The encoder
  // appends `_total` to counters as OpenMetrics requires.
  private readonly registry = new Registry();
  private readonly requests = new Counter({
    name: "x402_facilitator_requests",
    help: "Verify and settle requests answered, by step, network and outcome.",
    labelNames: ["step", "network", "outcome"],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: "x402_facilitator_duration_seconds",
    help: "Time to answer a verify or settle request, a settlement's receipt included.",
    labelNames: ["step", "network"],
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });
  private readonly inFlight = new Gauge({
    name: "x402_facilitator_settlements_in_flight",
    help: "Settlements received and not yet answered, by network.",
    labelNames: ["network"],
    registers: [this.registry],
  });
  private readonly signerBalance = new Gauge({
    name: "x402_facilitator_signer_balance_eth",
    help: "ETH the signer holds to pay gas, by network, as of its last successful read.",
    labelNames: ["network"],
    registers: [this.registry],
  });

  /** The networks settled on, the only ones given a label of their own. */
  private readonly networks: ReadonlySet<string>;

  constructor(settled: SettlementNetwork[]) {
    this.networks = new Set(settled.map(({ chain }) => networkId(chain)));
    this.registry.setContentType(openMetricsContentType);
    new Gauge({
      name: "x402_facilitator_build_info",
      help: "Version of the running facilitator.",
      labelNames: ["version"],
      registers: [this.registry],
    }).set({ version: VERSION }, 1);
  }

  /** Report the process itself, so a graph can tell a restart from a lull. */
  collectProcessMetrics(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  /** Record one verify or settle request answered. */
  recordRequest(step: Step, network: string, ended: Outcome, took: number): void {
    const label = this.networkLabel(network);
    this.requests.inc({ step, network: label, outcome: ended });
    this.duration.observe({ step, network: label }, took);
  }

  /** Count a settlement as in flight until the returned function is called. */
  settlementStarted(network: string): () => void {
    const label = { network: this.networkLabel(network) };
    this.inFlight.inc(label);
    return () => this.inFlight.dec(label);
  }

  /**
   * Record the signer's balance on `network`, or drop it when it could not be
   * read, so an alert sees a missing value rather than an old one.
   */
  recordBalance(network: string, eth: number | undefined): void {
    const label = { network: this.networkLabel(network) };
    if (eth === undefined) {
      this.signerBalance.remove(label);
    } else {
      this.signerBalance.set(label, eth);
    }
  }

  /** Render the current values as an OpenMetrics text exposition. */
  render(): Promise<string> {
    return this.registry.metrics();
  }

  private networkLabel(network: string): string {
    return this.networks.has(network) ? network : OTHER;
  }
}

/** `service`, recording every verify and settle it answers into `metrics`. */
export function measured(service: Service, metrics: FacilitatorMetrics): Service {
  return {
    getSupported: () => service.getSupported(),
    verify: (payload: PaymentPayload, requirements: PaymentRequirements) =>
      timed(
        metrics,
        "verify",
        requirements.network,
        () => service.verify(payload, requirements),
        ({ isValid }) => (isValid ? "valid" : "invalid"),
      ),
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements) => {
      const ended = metrics.settlementStarted(requirements.network);
      try {
        return await timed(
          metrics,
          "settle",
          requirements.network,
          () => service.settle(payload, requirements),
          ({ success, errorReason }) =>
            success ? "settled" : errorReason === SETTLEMENT_PENDING ? "pending" : "refused",
        );
      } finally {
        ended();
      }
    },
  };
}

/** Run `step`, then record how it ended and how long it took. */
async function timed<T>(
  metrics: FacilitatorMetrics,
  step: Step,
  network: string,
  run: () => Promise<T>,
  outcome: (answer: T) => Outcome,
): Promise<T> {
  const started = performance.now();
  try {
    const answer = await run();
    metrics.recordRequest(step, network, outcome(answer), seconds(started));
    return answer;
  } catch (err) {
    metrics.recordRequest(step, network, "error", seconds(started));
    throw err;
  }
}

/** How long to wait between one balance read finishing and the next starting. */
export const BALANCE_INTERVAL_MS = 10 * 60_000;

/**
 * Read `address`'s balance on every network now and then every ten minutes, into
 * `metrics`. The reads run on their own clients and timer, apart from any
 * verify or settle, and a read never starts while the previous one is still
 * running. Returns a function that stops the reads.
 */
export function watchBalances(
  metrics: FacilitatorMetrics,
  address: Address,
  networks: SettlementNetwork[],
  transport: (rpcUrl: string) => Transport = http,
): () => void {
  const clients = networks.map(({ chain, rpcUrl }) => ({
    chain,
    client: createPublicClient({ chain, transport: transport(rpcUrl) }),
  }));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const read = async () => {
    await Promise.all(
      clients.map(async ({ chain, client }) => {
        const network = networkId(chain);
        try {
          metrics.recordBalance(network, Number(formatEther(await client.getBalance({ address }))));
        } catch (err) {
          metrics.recordBalance(network, undefined);
          log.warn(`reading the signer balance on ${chain.name} failed: ${rpcFailure(err)}`);
        }
      }),
    );
    if (!stopped) {
      // Kept off the event loop's count, so it never holds the process open.
      timer = setTimeout(read, BALANCE_INTERVAL_MS).unref();
    }
  };
  void read();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
