# Build in CI or a separate build host; the small Tencent VPS need only run this image.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Optional managed-session CA; ordinary hosts use system CA trust.
RUN --mount=type=secret,id=proxy_ca if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; npm ci --strict-ssl=true
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
ENV NODE_ENV=test QA_HOST=0.0.0.0 QA_PORT=3301 QA_DATA_DIR=/app/data QA_HTTPS=false
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3301
CMD ["node","scripts/staging/start.mjs"]
