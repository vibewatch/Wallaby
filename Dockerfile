# syntax=docker/dockerfile:1
# =============================================================================
# Wallaby — multi-stage production Dockerfile
#
# Required runtime environment variables (set via `docker run -e` or compose):
#   DATABASE_URL   - Prisma datasource URL. Defaults to a SQLite file volume,
#                    e.g. file:/app/storage/wallaby.db
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
# Browser rendering (WALLABY_BROWSER_RENDER=true) needs Chromium in the image.
# Build with:  docker build --build-arg INSTALL_CHROMIUM=true -t wallaby .
# =============================================================================

# Prisma needs OpenSSL both while generating its native engine and while
# applying migrations at startup. CA certificates are also required for the
# application's outbound HTTPS fetches.
FROM node:24-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

# ---- Stage 1: install ALL dependencies (needed for prisma generate + build) -
FROM base AS deps
WORKDIR /app

COPY package*.json ./
# Workspace manifests are required so `npm ci` can resolve the local packages.
COPY packages/extractor/package.json packages/extractor/
COPY packages/extractor-site-config/package.json packages/extractor-site-config/

RUN npm ci

# ---- Stage 2: install production-only runtime dependencies ------------------
FROM base AS prod-deps
WORKDIR /app

COPY package*.json ./
COPY packages/extractor/package.json packages/extractor/
COPY packages/extractor-site-config/package.json packages/extractor-site-config/

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# npm v11 otherwise installs Next.js's optional @playwright/test peer even
# though the application depends only on the smaller runtime `playwright` API.
RUN npm ci --omit=dev --legacy-peer-deps

# ---- Stage 3: build the Next.js application ---------------------------------
FROM base AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate the Prisma client, then build. A fixed, unreachable placeholder
# DATABASE_URL keeps Prisma happy during route metadata collection — never bake
# real credentials into an image layer.
RUN npx prisma generate \
 && DATABASE_URL="file:/tmp/build.db" npm run build

# ---- Stage 4: production runner ---------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Persisted SQLite database and media volume by default.
ENV DATABASE_URL="file:/app/storage/wallaby.db"
ENV WALLABY_MEDIA_DIR="/app/storage/media"

# App build output and the production-only dependency tree. Prisma's generated
# client is produced in the build stage and copied over the clean runtime tree.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/packages ./packages
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Optionally install the Chromium version pinned by the application's Playwright
# dependency. This runs after node_modules is copied so the build never downloads
# an unrelated latest CLI through npx.
ARG INSTALL_CHROMIUM=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      npx playwright install --with-deps chromium; \
    fi

# Non-root user; the storage volume must be writable for SQLite + media.
RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs wallaby \
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
