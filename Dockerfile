FROM node:24-slim AS builder

WORKDIR /app
RUN corepack enable

# Dependencies first, so a source-only change reuses this layer. The workspace
# file carries the `ox` override, without which two copies of the Tempo decoder
# would install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Runtime stage: the two compiled programs, the bx402 proxy and the x402
# facilitator, their runtime dependencies, and the CA certificates they need to
# reach the upstreams over TLS.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --uid 10001 bx402

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Only what the programs run on; the compiler and the test tools stay behind.
# The store is dropped in the same layer, or its copy of every package ships
# too. node_modules hardlinks into it, so the files themselves survive.
RUN pnpm install --frozen-lockfile --prod \
    && rm -rf "$(pnpm store path)" ~/.cache/node/corepack
COPY --from=builder /app/dist ./dist
# The proxy serves the buyer's guide and the service icon off disk at runtime;
# without them it refuses to start.
COPY llms.txt icon.png ./

# Expose the traffic port and the metrics port, the same for both programs.
# Only the proxy's traffic port should ever be reachable from outside the
# network; the facilitator's is for the proxy alone.
EXPOSE 8080
EXPOSE 8090

# Run unprivileged: neither program needs root, and both bind 8080 and 8090 (>1024)
USER bx402
# The proxy by default. The facilitator runs from this same image with
# `node dist/facilitator/main.js` as its entrypoint, as compose.yaml does.
ENTRYPOINT ["node", "dist/main.js"]
