FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/broker/package.json ./packages/broker/package.json
COPY packages/trading/package.json ./packages/trading/package.json
COPY packages/database/package.json ./packages/database/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY packages ./packages
RUN pnpm -r --filter './packages/*' --filter @hth/api --filter @hth/worker build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV TRADING_MODE=paper
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
CMD ["node", "apps/api/dist/main.js"]
