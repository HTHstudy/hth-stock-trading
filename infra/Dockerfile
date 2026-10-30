FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/broker/package.json ./packages/broker/package.json
COPY packages/trading/package.json ./packages/trading/package.json
COPY packages/database/package.json ./packages/database/package.json
RUN --mount=type=secret,id=npm_ca \
    if [ -s /run/secrets/npm_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca NPM_CONFIG_CAFILE=/run/secrets/npm_ca; \
    fi; \
    pnpm install --frozen-lockfile
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY apps/web ./apps/web
COPY packages ./packages
RUN pnpm -r build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV TRADING_MODE=paper
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/.local-data /tmp/hth-dashboard-1000 && chown node:node /app/.local-data /tmp/hth-dashboard-1000 && chmod 700 /app/.local-data /tmp/hth-dashboard-1000
USER node
CMD ["node", "apps/api/dist/main.js"]

FROM caddy:2-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile
