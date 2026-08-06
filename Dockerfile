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
#   WALLABY_BROWSER_RENDER  - Render challenged/JS-heavy pages in headless
#                             Chromium. Requires the image to be built with
#                             --build-arg INSTALL_CHROMIUM=true (see below).
#   SITE_CREDENTIALS_KEY, TWO_FACTOR_*, POCKET_TOKEN_KEY - see .env.example
#
# Browser rendering (WALLABY_BROWSER_RENDER=true) needs Chromium in the image.
# Build with:  docker build --build-arg INSTALL_CHROMIUM=true -t wallaby .
# =============================================================================

# ---- Stage 1: install ALL dependencies (needed for prisma generate + build) -
FROM node:24-bookworm-slim AS deps
WORKDIR /app

COPY package*.json ./
# Workspace manifests are required so `npm ci` can resolve the local packages.
COPY packages/extractor/package.json packages/extractor/
COPY packages/extractor-site-config/package.json packages/extractor-site-config/

RUN npm ci

# ---- Stage 2: build the Next.js application ---------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate the Prisma client, then build. A fixed, unreachable placeholder
# DATABASE_URL keeps Prisma happy during route metadata collection — never bake
# real credentials into an image layer.
RUN npx prisma generate \
 && DATABASE_URL="file:/tmp/build.db" npm run build

# ---- Stage 3: production runner ---------------------------------------------
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Persisted SQLite database and media volume by default.
ENV DATABASE_URL="file:/app/storage/wallaby.db"
ENV WALLABY_MEDIA_DIR="/app/storage/media"

# Optionally install Chromium + its system libraries for headless rendering.
# Kept off by default so the base image stays small; enable per the header.
ARG INSTALL_CHROMIUM=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      npx --yes playwright install --with-deps chromium; \
    fi

# App build output and the production dependency tree.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/docker-entrypoint.sh ./docker-entrypoint.sh

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

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
