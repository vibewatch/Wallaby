# syntax=docker/dockerfile:1
# =============================================================================
# Wallaby — multi-stage production Dockerfile
#
# Required runtime environment variables (set via `docker run -e` or compose):
#   DATABASE_URL   - Prisma datasource URL matching DATABASE_PROVIDER at build.
#                    SQLite is the local default; production builds PostgreSQL.
#   AUTH_SECRET    - Long random secret for Auth.js session signing (required)
#
# Optional (features degrade gracefully when absent) — see .env.example:
#   WALLABY_MEDIA_DIR       - Persistent volume for downloaded article images
#   WALLABY_BOT_PROFILES    - Retry bot-challenged fetches with search-bot /
#                             browser request profiles ("true"/"false")
#   WALLABY_BROWSER_RENDER  - Render still-challenged pages in headless
#                             Chromium. Requires the image to be built with
#                             --build-arg INSTALL_CHROMIUM=true (see below).
#   SITE_CREDENTIALS_KEY, TWO_FACTOR_*, POCKET_TOKEN_KEY - see .env.example
#
# PostgreSQL: docker build --build-arg DATABASE_PROVIDER=postgresql -t wallaby .
# Browser rendering (WALLABY_BROWSER_RENDER=true) needs Chromium in the image.
# Build with:  docker build --build-arg INSTALL_CHROMIUM=true -t wallaby .
# =============================================================================

# Prisma needs OpenSSL both while generating its native engine and while
# applying migrations at startup. CA certificates are also required for the
# application's outbound HTTPS fetches.
ARG INSTALL_CHROMIUM=false
ARG ALPINE_VERSION=3.24
FROM node:24-alpine${ALPINE_VERSION} AS base-false
RUN apk add --no-cache ca-certificates openssl

# Playwright requires glibc; the existing browser flag selects Debian throughout
# the build so native Prisma, sharp and canvas binaries match the final runtime.
FROM node:24-bookworm-slim AS base-true
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

FROM base-${INSTALL_CHROMIUM} AS base

# ---- Stage 1: install ALL dependencies (needed for prisma generate + build) -
FROM base AS deps
WORKDIR /app

COPY package*.json ./
# Workspace manifests are required so `npm ci` can resolve the local packages.
COPY packages/extractor/package.json packages/extractor/
COPY packages/extractor-site-config/package.json packages/extractor-site-config/

RUN npm ci \
 && node -e "require('sharp'); require('@napi-rs/canvas').createCanvas(1, 1)"

# ---- Stage 2: build the Next.js application and operator entrypoints --------
FROM base AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG DEPLOYMENT_VERSION
ENV DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION
ARG DATABASE_PROVIDER=sqlite
ENV DATABASE_PROVIDER=$DATABASE_PROVIDER

# Generate the Prisma client, then build. A fixed, unreachable placeholder
# DATABASE_URL keeps Prisma happy during route metadata collection — never bake
# real credentials into an image layer.
RUN npm run db:generate \
 && if [ "$DATABASE_PROVIDER" = "postgresql" ]; then \
      DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" npm run build; \
    else DATABASE_URL="file:/tmp/build.db" npm run build; fi
RUN node scripts/build-runtime.mjs

# Assemble the union of server/operator traces before the final image copy.
FROM base AS runtime-files
COPY --from=build /app/.next/runtime /app/
RUN find /app/node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.tsbuildinfo' \) -delete

# Copy only Node and npm into a matching Alpine runtime: no Yarn or C headers.
FROM alpine:${ALPINE_VERSION} AS runtime-false
RUN apk add --no-cache ca-certificates openssl libstdc++
COPY --from=base-false /usr/local/bin/node /usr/local/bin/node
COPY --from=base-false /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

FROM base-true AS runtime-true

# ---- Stage 4: production runner ---------------------------------------------
FROM runtime-${INSTALL_CHROMIUM} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Persisted SQLite database and media volume by default.
ENV DATABASE_URL="file:/app/storage/wallaby.db"
ARG DATABASE_PROVIDER=sqlite
ENV DATABASE_PROVIDER=$DATABASE_PROVIDER
ENV WALLABY_MEDIA_DIR="/app/storage/media"

# App output, compiled operators, platform engines and traced dependencies.
COPY --from=runtime-files /app/ ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Optionally install the Chromium version pinned by the application's Playwright
# dependency. This runs after node_modules is copied so the build never downloads
# an unrelated latest CLI through npx.
ARG INSTALL_CHROMIUM=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium; \
    fi

# Non-root user; the storage volume must be writable for SQLite + media.
RUN if command -v apk >/dev/null; then \
      addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs wallaby; \
    else groupadd --system --gid 1001 nodejs \
      && useradd --system --uid 1001 --gid nodejs wallaby; fi \
 && mkdir -p /app/storage/media \
 && chown -R wallaby:nodejs /app/storage \
 && chmod +x ./docker-entrypoint.sh
# Chromium (if installed) lives outside /app; make it readable by the app user.
RUN if [ -d /ms-playwright ]; then chown -R wallaby:nodejs /ms-playwright; fi

USER wallaby
EXPOSE 3000
VOLUME ["/app/storage"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
