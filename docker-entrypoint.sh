#!/bin/sh
set -e

# Apply pending Prisma migrations against the configured DATABASE_URL, then hand
# off to the container command (web server by default, see Dockerfile CMD).
echo "Wallaby: applying database migrations..."
npx prisma migrate deploy

exec "$@"
