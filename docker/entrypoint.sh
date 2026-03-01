#!/bin/sh

set -e

echo "=== Ghostfolio + Agent Startup ==="

# ─── Database migrations ─────────────────────────────────────────────
echo "Running database migrations..."
npx prisma migrate deploy || echo "WARNING: prisma migrate failed (may be fine on first run)"

echo "Seeding the database..."
npx prisma db seed || echo "WARNING: prisma seed failed (may already be seeded)"

# ─── Start the agent as a background process ─────────────────────────
echo "Starting ghostfolio-agent on port 3334..."
AGENT_PORT="${AGENT_PORT:-3334}"
export PORT="$AGENT_PORT"
export GHOSTFOLIO_API_URL="http://localhost:${GHOSTFOLIO_PORT:-3333}"
export AGENT_AUTH_MODE="${AGENT_AUTH_MODE:-ghostfolio_shared}"

cd /ghostfolio/agent
node dist/server/main.js &
AGENT_PID=$!
cd /ghostfolio/apps/api

# Wait for agent to be ready
echo "Waiting for agent to start..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${AGENT_PORT}/health" > /dev/null 2>&1; then
    echo "Agent is ready on port ${AGENT_PORT}"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "WARNING: Agent did not become ready in 30s, continuing anyway"
  fi
  sleep 1
done

# ─── Start the Ghostfolio server (foreground) ─────────────────────────
echo "Starting Ghostfolio server..."
export PORT="${GHOSTFOLIO_PORT:-3333}"
export AGENT_SERVICE_URL="http://localhost:${AGENT_PORT}"

# Trap signals to shut down both processes
cleanup() {
  echo "Shutting down..."
  kill $AGENT_PID 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

exec node main
