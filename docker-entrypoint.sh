#!/bin/sh
set -e
umask 077

# Reject unsafe configuration before touching persistent storage, then apply
# pending migrations and hand off to the requested process.
echo "Wallaby: validating production configuration..."
npm run config:validate

echo "Wallaby: applying database migrations..."
npx prisma migrate deploy

exec "$@"
