# Nekko Artifacts server. Build from the REPO ROOT:
#   docker build -f apps/artifact-server/Dockerfile -t nekko-agent-artifacts .
# Run (see docker-compose.yml beside this file for the usual setup):
#   docker run -p 4500:4500 -p 4501:4501 -e NEKKO_ARTIFACTS_TOKEN=... -v artifacts:/data nekko-agent-artifacts
# Port 4500 is the upload API, 4501 serves published artifacts. Keep them on
# different origins (different ports or hosts) in front of any proxy.

FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/artifact-server/package.json apps/artifact-server/package.json
# --include-workspace-root pulls the root devDeps (typescript, @types/node).
RUN npm ci -w @nekko-agent/artifact-server --include-workspace-root --ignore-scripts
COPY apps/artifact-server apps/artifact-server
RUN npx tsc -p apps/artifact-server/tsconfig.json

FROM node:22-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/artifact-server/package.json apps/artifact-server/package.json
RUN npm ci -w @nekko-agent/artifact-server --omit=dev --ignore-scripts

FROM node:22-slim
ENV NODE_ENV=production NEKKO_ARTIFACTS_DATA=/data
WORKDIR /app
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/artifact-server/dist ./dist
COPY apps/artifact-server/package.json ./package.json
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4500 4501
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.NEKKO_ARTIFACTS_API_PORT||4500)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
