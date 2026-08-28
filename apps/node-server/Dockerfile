# Build context = raíz del repo (necesita packages/protocol y el cliente compilado).
# Node 24 ejecuta TypeScript directamente, así que el servidor no necesita compilarse.

# --platform=$BUILDPLATFORM: la web compilada es JS/CSS independiente de la
# arquitectura, así que esta etapa corre en la nativa del runner y el build
# multi-arch (linux/arm64 + amd64 del job `docker` de release.yml) no paga
# el peaje de qemu más que en la etapa final.
FROM --platform=$BUILDPLATFORM node:24-alpine AS client
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/node-server/package.json ./apps/node-server/
COPY packages/protocol/package.json ./packages/protocol/
RUN npm ci
COPY packages/protocol ./packages/protocol
COPY apps/web ./apps/web
RUN npm run build --workspace @distop/web

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/node-server/package.json ./apps/node-server/
COPY packages/protocol/package.json ./packages/protocol/
RUN npm ci --omit=dev --workspace @distop/node-server --include-workspace-root

COPY packages/protocol ./packages/protocol
COPY apps/node-server ./apps/node-server
COPY --from=client /repo/apps/web/dist ./apps/web/dist

# Sin privilegios: la instancia no necesita root para nada (§22).
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV DATABASE_PATH=/data/app.db
ENV DEFAULT_STORAGE_PATH=/data/uploads
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/node-server
CMD ["node", "server.ts"]
