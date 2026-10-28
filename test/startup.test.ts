import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/** The repository root, one level up from this file. */
const ROOT = join(import.meta.dirname, "..");

/** The built entrypoints these tests run, the same ones the containers start. */
const ENTRYPOINT = join(ROOT, "dist", "main.js");
const FACILITATOR_ENTRYPOINT = join(ROOT, "dist", "facilitator", "main.js");

/**
 * An empty directory to run the entrypoints from. They load a `.env` beside
 * their working directory, and a local one, or a stray one in the shared temp
 * directory, would otherwise supply the very settings a test is proving are
 * missing.
 */
const EMPTY_DIR = mkdtempSync(join(tmpdir(), "bx402-startup-"));

/** A well-formed signing key that holds nothing. */
const KEY = `0x${"11".repeat(32)}`;

/**
 * Start the service with `env` and hand back what it printed and how it exited.
 *
 * The environment is built from scratch, for the same reason the entrypoint
 * runs from an empty directory.
 */
function startWith(
  env: Record<string, string>,
  entrypoint = ENTRYPOINT,
  cwd = EMPTY_DIR,
): { code: number; stderr: string } {
  try {
    execFileSync("node", [entrypoint], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A process that starts serving instead of refusing is killed, and the
      // test fails on its exit code rather than hanging.
      timeout: 10_000,
    });
  } catch (err: unknown) {
    const failure = err as { status?: number; stderr?: string };
    return { code: failure.status ?? 0, stderr: failure.stderr ?? "" };
  }
  throw new Error("the service started when it should have refused to");
}

beforeAll(() => {
  // These tests drive the built entrypoint rather than the modules, so build it
  // first. Compiling here keeps the test self-contained instead of depending on
  // whatever a previous command happened to leave in `dist`.
  execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
    cwd: ROOT,
    stdio: "ignore",
  });
}, 120_000);

describe("startup", () => {
  it("missing_api_key_reports_clear_message_and_exits_nonzero", () => {
    const { code, stderr } = startWith({});

    expect(code).toBe(1);
    expect(stderr, `stderr was: ${stderr}`).toContain(
      "missing required configuration: BRAVE_SEARCH_API_KEY",
    );
  });

  it("bad_enabled_rails_reports_clear_message_and_exits_nonzero", () => {
    // The API key is set explicitly, so the failure is the rails value and not
    // the setting the test above covers.
    const { code, stderr } = startWith({
      BRAVE_SEARCH_API_KEY: "test-key",
      ENABLED_RAILS: "btc",
    });

    expect(code).toBe(1);
    expect(stderr, `stderr was: ${stderr}`).toContain("invalid configuration: ENABLED_RAILS");
  });
});

describe("facilitator startup", () => {
  it("missing_signer_reports_clear_message_and_exits_nonzero", () => {
    const { code, stderr } = startWith({}, FACILITATOR_ENTRYPOINT);

    expect(code).toBe(1);
    expect(stderr, `stderr was: ${stderr}`).toContain(
      "missing required configuration: FACILITATOR_KMS_KEY_ID or FACILITATOR_PRIVATE_KEY",
    );
  });

  it("unreachable_rpc_stops_startup_before_serving", () => {
    // Nothing listens on port 9, so the network check fails and the
    // facilitator never reaches its listener.
    const { code, stderr } = startWith(
      { FACILITATOR_PRIVATE_KEY: KEY, BASE_RPC_URL: "http://127.0.0.1:9" },
      FACILITATOR_ENTRYPOINT,
    );

    expect(code).toBe(1);
    expect(stderr, `stderr was: ${stderr}`).toContain("invalid configuration: Base RPC");
  });

  it("unreadable_dotenv_stops_startup", () => {
    // A directory where the `.env` file should be: present, but not a file
    // that can be read.
    const cwd = mkdtempSync(join(tmpdir(), "bx402-startup-"));
    mkdirSync(join(cwd, ".env"));

    const { code, stderr } = startWith({}, FACILITATOR_ENTRYPOINT, cwd);

    expect(code).toBe(1);
    expect(stderr, `stderr was: ${stderr}`).toContain("invalid configuration: .env");
  });
});

describe("facilitator shutdown", () => {
  it("sigterm_finishes_requests_in_flight_then_exits_zero", async () => {
    // A stand-in RPC that answers the startup checks: chain Base, some balance.
    const rpc = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        const result = method === "eth_chainId" ? "0x2105" : "0x1";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    rpc.listen(0, "127.0.0.1");
    await once(rpc, "listening");
    const { port } = rpc.address() as AddressInfo;

    const facilitator = spawn("node", [FACILITATOR_ENTRYPOINT], {
      cwd: EMPTY_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        FACILITATOR_PRIVATE_KEY: KEY,
        BASE_RPC_URL: `http://127.0.0.1:${port}`,
        // A free port, so the test never meets another service on 8080.
        FACILITATOR_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(facilitator, "exit");
    let stderr = "";
    facilitator.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Resolves once the facilitator has logged `line`, and fails at once if it
    // exits first, with what it printed.
    const logged = (line: string) =>
      Promise.race([
        new Promise<void>((resolve) => {
          const check = () => stderr.includes(line) && resolve();
          facilitator.stderr.on("data", check);
          check();
        }),
        exited.then(() => {
          throw new Error(`exited before logging "${line}": ${stderr}`);
        }),
      ]);

    try {
      await logged("listening on");
      const listening = Number(/listening on [^:]+:(\d+)/.exec(stderr)?.[1]);

      // Open a request and hold its body back, so it is still in flight when
      // the signal arrives.
      const held = request({
        host: "127.0.0.1",
        port: listening,
        method: "POST",
        path: "/settle",
        headers: { "transfer-encoding": "chunked" },
      });
      const answered = once(held, "response");
      held.write("{");
      await new Promise((resolve) => setTimeout(resolve, 200));

      facilitator.kill("SIGTERM");
      await logged("finishing requests in flight");
      held.end("}");

      const [response] = (await answered) as [IncomingMessage];
      expect(response.statusCode).toBe(400);
      // The answer closes its connection, so a caller that keeps connections
      // open cannot hold the stop open with new requests.
      expect(response.headers.connection).toBe("close");
      const [code] = await exited;
      expect(code, `stderr was: ${stderr}`).toBe(0);
    } finally {
      facilitator.kill("SIGKILL");
      rpc.close();
    }
  }, 20_000);
});
