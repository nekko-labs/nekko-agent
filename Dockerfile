# syntax=docker/dockerfile:1

# ---- nekkod: the Rust engine daemon the web edition runs behind ----
# Debian 13: the prebuilt ONNX Runtime nekkod links needs a GCC 13+ libstdc++.
FROM rust:1-slim-trixie AS nekkod
WORKDIR /src
# ort (the decision models' ONNX Runtime) downloads its prebuilt static library over
# native TLS at build time and links it with the C++ runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates g++ \
    && rm -rf /var/lib/apt/lists/*
# rust-toolchain.toml pins the compiler; rustup installs it on first use.
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build -p nekkod --release --locked \
    && mkdir -p /out \
    && cp target/release/nekkod /out/ \
    # Shared libraries ONNX Runtime loads from beside the binary, when the build made any.
    && find target/release -maxdepth 1 -name 'libonnxruntime*.so*' -exec cp {} /out/ \;

# ---- builder: install + build the whole monorepo (web edition) ----
FROM node:22-trixie-slim AS builder
WORKDIR /app

# Electron is a devDependency of @nekko-agent/desktop; the web edition only needs the
# renderer build, so skip downloading the (large) Electron binary.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/host/package.json packages/host/
COPY apps/desktop/package.json apps/desktop/
COPY apps/web-app-server/package.json apps/web-app-server/
COPY apps/cli/package.json apps/cli/
RUN npm ci

COPY . .
RUN npm run build:web
# Drop dev dependencies so the runtime image stays lean.
RUN npm prune --omit=dev

# ---- runtime: Node, the built artifacts and nekkod ----
FROM node:22-trixie-slim AS runtime
WORKDIR /app
# tini as PID 1: it forwards `docker stop`'s SIGTERM to the server (which stops
# nekkod, which stops its backend and terminals) and reaps any orphaned shell.
# libssl3: nekkod links OpenSSL dynamically (Node's own is static).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEKKO_HOST=0.0.0.0 \
    NEKKO_PORT=1440 \
    NEKKO_DATA_DIR=/data

# Copy the pruned install + build outputs, preserving the workspace layout the
# server expects (apps/web-app-server/dist resolves ../../desktop/out/renderer).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/web-app-server/dist ./apps/web-app-server/dist
COPY --from=builder /app/apps/web-app-server/package.json ./apps/web-app-server/package.json
COPY --from=builder /app/apps/cli ./apps/cli
COPY --from=builder /app/apps/desktop/out/renderer ./apps/desktop/out/renderer
# The server finds the daemon in bin/ beside its script.
COPY --from=nekkod /out/ ./apps/web-app-server/dist/bin/

RUN mkdir -p /data /workspace && chown -R node:node /data /workspace /app
USER node

EXPOSE 1440
VOLUME ["/data", "/workspace"]

# /health is outside /api and needs no token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.NEKKO_PORT||1440)+'/health').then(r=>r.json()).then(h=>process.exit(h.ok&&h.daemon&&h.daemon.ready?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "if [ -z \"$NEKKO_TOKEN\" ]; then NEKKO_TOKEN=$(node -e \"console.log(require('node:crypto').randomBytes(24).toString('base64url'))\"); export NEKKO_TOKEN; echo \"Nekko Agent token: $NEKKO_TOKEN\"; fi; exec node apps/web-app-server/dist/index.js"]
