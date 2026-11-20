FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY lib/db/package.json lib/db/
COPY lib/board-protocol/package.json lib/board-protocol/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile --filter "./apps/*" --filter "./lib/*"
COPY apps apps
COPY lib lib
RUN pnpm build

# The server is a single bundled file, so the runtime image needs no node_modules.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MONET_CONTAINER=1
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/lib/db/migrations lib/db/migrations
COPY LICENSE NOTICE THIRD_PARTY_LICENSES.md ./
COPY licenses licenses
RUN useradd --system --uid 10001 monet
USER monet
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "apps/server/dist/index.mjs"]
