FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# ── Production stage ──────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y curl gosu && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy only the compiled output and source assets (no TS compiler, no @types)
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./

# Security: create non-root user for runtime
RUN groupadd -r par && useradd -r -g par -u 999 par && \
    mkdir -p /data/meta && chown -R par:par /data && \
    chmod +x /app/docker-entrypoint.sh

# Entrypoint runs as root to fix permissions, then drops to par user
ENTRYPOINT ["/app/docker-entrypoint.sh"]

EXPOSE 3100

CMD ["node", "dist/server.js"]
