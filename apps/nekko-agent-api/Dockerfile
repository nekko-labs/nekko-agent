# Nekko Agent API. Build context is apps/nekko-agent-api (see fly.toml).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY start.sh ./
USER node
EXPOSE 8080
# start.sh caps the heap at NODE_HEAP_PERCENT of the machine (README "Memory").
# Starting `node` directly here would drop the cap; the startup log warns if it does.
CMD ["./start.sh"]
