FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/client-sdk/package.json ./packages/client-sdk/package.json

RUN npm ci

COPY apps/server ./apps/server
COPY packages/client-sdk ./packages/client-sdk

RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/client-sdk/package.json ./packages/client-sdk/package.json

RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/apps/server/dist ./apps/server/dist

EXPOSE 8787

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
