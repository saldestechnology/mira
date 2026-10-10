FROM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# ICON_SETS=curated builds the small icon list (docker build --build-arg ICON_SETS=curated); the default hosts every allowed set.
# The icons go to their own layer in the final stage, so an app-only change does not push them again.
ARG ICON_SETS=all
RUN --mount=type=cache,target=/app/node_modules/.cache/tabula-icons npm run build && mv dist/icons /icons

FROM node:26-alpine
WORKDIR /app
# The release label of this build (docker build --build-arg TABULA_VERSION=2026.10.09-1, or fly deploy --build-arg ...). The server reports it
# on GET /api/internal/version for a control plane that rolls images out (docs/migrations.md); empty when it was not given.
ARG TABULA_VERSION=
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data TABULA_VERSION=$TABULA_VERSION
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /icons ./dist/icons
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
# The Linear importer (docs/linear-import.md) runs inside the image against a stopped workspace; nothing else from scripts/ ships.
COPY scripts/linear-import.mjs scripts/linear-verify.mjs ./scripts/
COPY scripts/lib/linear-source.mjs ./scripts/lib/
VOLUME /data
EXPOSE 8787
CMD ["node", "server/relay.mjs"]
