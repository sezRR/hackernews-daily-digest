# One image runs both processes: the reply reader (default) and the digest, which cron starts.
FROM node:26-slim AS base
RUN npm install --global pnpm@12.17.0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./

# Runtime dependencies only. None of them need install scripts: SQLite is built into Node.
FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM node:26-slim
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/hackernews.db
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# A new named volume copies this directory's owner, so the node user can write to it.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
CMD ["node", "dist/run-replies.js"]
