# syntax=docker/dockerfile:1
# Node 22 Maintenance LTS, pinned across both architectures.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# esbuild reads jsconfig too; omitting it changes emitted class-field semantics
# and produces different SDK/SRI bytes from the same sources.
COPY jsconfig.json ./
COPY src ./src
# MCP lifecycle helpers are bundled from the host store modules, so the whole
# entrypoint set is present before the bundle runs rather than one file at a time.
COPY server ./server
COPY types ./types
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build
# This CLI comes from npm ci, not an unpinned npx download. Its browser revision
# is locked by package-lock.json. Default headless launches use only this shell.
RUN node node_modules/playwright-core/cli.js install --only-shell chromium

FROM base AS runtime
ENV NODE_ENV=production HOME=/tmp/pwuser NAVI_MODE=host
# `node:sqlite` is the store's preferred backend and IS importable without this
# flag from Node 22.13 (nodejs/node#55890), which is what the pinned base is - so
# on this image the flag is belt-and-braces, not the enabler, and the store's own
# import is what actually decides. It is still set because it is the supported way
# to reach the module on 22.5-22.12, it is legal in NODE_OPTIONS on both lines, and
# an explicit flag is the honest record of the intent. The import emits an
# ExperimentalWarning at startup wherever it succeeds; that warning is accurate (the
# module is Stability 1 on Node 22) and is not suppressed here.
ENV NODE_OPTIONS="--experimental-sqlite"
# Only playwright-core is needed at runtime: MCP/host have no other external
# imports. Do not copy the development toolchain, test libraries or tokenizers.
COPY --from=build /app/node_modules/playwright-core ./node_modules/playwright-core
RUN node node_modules/playwright-core/cli.js install-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* \
    && usermod --login pwuser --home /tmp/pwuser node \
    && groupmod --new-name pwuser node \
    && mkdir -p /data /var/lib/navi/mcp \
    && chown pwuser:pwuser /data /var/lib/navi/mcp \
    && chmod 0700 /var/lib/navi/mcp
COPY --from=build /opt/playwright /opt/playwright
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY bin ./bin
COPY server ./server
COPY src/crawler-payload.js ./src/crawler-payload.js
COPY scripts/check-sandbox.mjs ./scripts/check-sandbox.mjs
COPY scripts/docker-entrypoint.sh /usr/local/bin/navi-entrypoint
RUN chmod 0555 /usr/local/bin/navi-entrypoint
USER pwuser:pwuser
EXPOSE 3000 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.NAVI_PORT||(process.env.NAVI_MODE==='mcp'?'3001':'3000'))+'/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["navi-entrypoint"]
