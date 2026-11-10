FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep procps && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /app
COPY container/package.json ./package.json
RUN npm install --omit=dev && node -e "import('@deepseek-ai/dsh-sdk-client').then(m=>{if(!m.DeepSeekHarness)process.exit(1)})"
COPY container/server.mjs ./server.mjs
COPY container/approvals.mjs ./approvals.mjs
COPY container/sessions.mjs ./sessions.mjs
COPY container/site-check.mjs ./site-check.mjs
COPY container/demo-environment.mjs ./demo-environment.mjs
COPY container/demo-sales.csv ./demo-sales.csv
RUN node --check /app/demo-environment.mjs
COPY container/build-review-deck.mjs ./build-review-deck.mjs
COPY container/deck-template.html ./deck-template.html
RUN node --check /app/build-review-deck.mjs
COPY container/history.mjs ./history.mjs
COPY container/timing.mjs ./timing.mjs
COPY container/gateway.cordis.yml ./gateway.cordis.yml
RUN node --check /app/server.mjs && node --check /app/sessions.mjs && node --check /app/approvals.mjs && node --check /app/site-check.mjs
# Both named images receive exactly the same tools and demo resources above.
RUN test -s /app/demo-environment.mjs && test -s /app/demo-sales.csv && test -s /app/site-check.mjs && test -s /app/build-review-deck.mjs && test -s /app/deck-template.html
ARG DSH_APP_VERSION=v1
RUN node -e "require('fs').writeFileSync('/app/runtime-version.json', JSON.stringify({version:process.argv[1]}))" "$DSH_APP_VERSION"
RUN mkdir -p /data/dsh-home /data/workspace
CMD ["sleep", "infinity"]
