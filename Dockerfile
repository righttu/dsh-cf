FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep procps && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /app
COPY container/package.json ./package.json
RUN npm install --omit=dev && node -e "import('@deepseek-ai/dsh-sdk-client').then(m=>{if(!m.DeepSeekHarness)process.exit(1)})"
COPY container/server.mjs ./server.mjs
COPY container/history.mjs ./history.mjs
COPY container/gateway.cordis.yml ./gateway.cordis.yml
RUN node --check /app/server.mjs
RUN mkdir -p /data/dsh-home /data/workspace
CMD ["sleep", "infinity"]
