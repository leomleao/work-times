FROM node:24-bookworm-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN pnpm build

FROM build AS tools

RUN cp -R /root/.cache/node/corepack/v1/pnpm/11.13.0 /opt/pnpm \
  && chmod -R a+rX /opt/pnpm

ENTRYPOINT ["node", "/opt/pnpm/bin/pnpm.cjs"]

FROM build AS production-dependencies

RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3002
ENV DATABASE_PATH=/data/work-times.sqlite

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/build ./build
COPY --from=production-dependencies --chown=node:node /app/server ./server
COPY --from=production-dependencies --chown=node:node /app/migrations ./migrations
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/package.json ./package.json

RUN mkdir -p /data && chown node:node /data && chmod 0700 /data

USER node

EXPOSE 3002
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3002/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server/index.mjs"]
