# syntax=docker/dockerfile:1
# Node 20 is a compatibility requirement, but is EOL. See docs/CONTAINERS.md.
FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS base
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# esbuild reads jsconfig too; omitting it changes emitted class-field semantics
# and produces different SDK/SRI bytes from the same sources.
COPY jsconfig.json ./
COPY src ./src
COPY types ./types
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build
# This CLI comes from npm ci, not an unpinned npx download. Its browser revision
# is locked by package-lock.json. Default headless launches use only this shell.
RUN node node_modules/playwright-core/cli.js install --only-shell chromium

FROM base AS runtime
ENV NODE_ENV=production HOME=/tmp/navi NAVI_MODE=host
# Only playwright-core is needed at runtime: MCP/host have no other external
# imports. Do not copy the development toolchain, test libraries or tokenizers.
COPY --from=build /app/node_modules/playwright-core ./node_modules/playwright-core
RUN node node_modules/playwright-core/cli.js install-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* \
    && mkdir -p /data \
    && chown node:node /data
COPY --from=build /opt/playwright /opt/playwright
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY bin ./bin
COPY server ./server
COPY scripts/docker-entrypoint.sh /usr/local/bin/navi-entrypoint
RUN chmod 0555 /usr/local/bin/navi-entrypoint
USER node:node
EXPOSE 3000 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.NAVI_PORT||(process.env.NAVI_MODE==='mcp'?'3001':'3000'))+'/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["navi-entrypoint"]
