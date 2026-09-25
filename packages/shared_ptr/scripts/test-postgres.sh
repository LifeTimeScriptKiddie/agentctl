#!/bin/sh
# Run the shared_ptr tests against a real, throwaway Postgres 16 in Docker.
# The regular suite mocks pg; this is the check that the DB backend really works.
#   packages/shared_ptr/scripts/test-postgres.sh [vitest args…]
set -eu
NAME="sptr-pg-test-$$"
PORT="${SHARED_PTR_TEST_PG_PORT:-55433}"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run -d --name "$NAME" -e POSTGRES_USER=sptr -e POSTGRES_PASSWORD=sptr -e POSTGRES_DB=sptr \
  -p "127.0.0.1:$PORT:5432" postgres:16-alpine >/dev/null
i=0; until docker exec "$NAME" pg_isready -U sptr >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "postgres did not start" >&2; exit 1; }; sleep 1
done
URL="postgres://sptr:sptr@127.0.0.1:$PORT/sptr"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
SHARED_PTR_MEMORY_BACKEND=postgres SHARED_PTR_MEMORY_DATABASE_URL="$URL" \
  node packages/shared_ptr/dist/cli.js postgres migrate >/dev/null
TEST_SHARED_PTR_DATABASE_URL="$URL" npx vitest run test/sharedPtrBackend.test.ts test/contract.test.ts "$@"
