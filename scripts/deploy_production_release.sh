#!/usr/bin/env bash

set -euo pipefail

COMPOSE_FILE="docker-compose.production.yml"
REQUIRED_ENV_VARS=(
  ENVIRONMENT
  NEO4J_USER
  NEO4J_PASSWORD
  POSTGRES_USER
  POSTGRES_PASSWORD
  POSTGRES_DB
  REDIS_PASSWORD
  CLICKHOUSE_DB
  CLICKHOUSE_USER
  CLICKHOUSE_PASSWORD
  JWT_SECRET_KEY
  ALLIUM_API_KEY
  ETHERSCAN_API_KEY
)

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_env_file_value() {
  local name="$1"

  if ! awk -F= -v key="$name" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      split(line, parts, "=")
      field = parts[1]
      gsub(/[[:space:]]/, "", field)
      if (field == key) {
        value = substr(line, index(line, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        gsub(/^["'\'']|["'\'']$/, "", value)
        if (value != "") found = 1
      }
    }
    END { exit found ? 0 : 1 }
  ' .env; then
    fail "missing required variable in .env: $name"
  fi
}

wait_for_container_health() {
  local service="$1"
  local timeout_seconds="${2:-120}"
  local elapsed=0
  local status=""
  local container_id=""

  log "waiting for ${service} container health"

  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    container_id="$(docker compose -f "$COMPOSE_FILE" ps -q "$service")"
    if [ -n "$container_id" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
      if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
        log "${service} status: ${status}"
        return 0
      fi
    fi

    sleep 5
    elapsed=$((elapsed + 5))
  done

  fail "${service} did not become healthy within ${timeout_seconds}s"
}

release_branch="${1:-}"

case "$release_branch" in
  release-*) ;;
  "") fail "release branch argument is required" ;;
  *) fail "branch must match release-*" ;;
esac

require_command git
require_command docker

[ -f "$COMPOSE_FILE" ] || fail "missing $COMPOSE_FILE"
[ -f ".env" ] || fail "missing .env"

for name in "${REQUIRED_ENV_VARS[@]}"; do
  require_env_file_value "$name"
done

previous_commit="$(git rev-parse --short HEAD)"
log "previous commit: ${previous_commit}"
log "syncing ${release_branch}"

git fetch origin "$release_branch"
git checkout "$release_branch"
git reset --hard "origin/$release_branch"

current_commit="$(git rev-parse --short HEAD)"
log "deploying commit: ${current_commit}"

log "validating production compose"
docker compose -f "$COMPOSE_FILE" config --quiet

log "pulling image-based services"
docker compose -f "$COMPOSE_FILE" pull neo4j postgres redis clickhouse prometheus grafana || true

log "building application services"
docker compose -f "$COMPOSE_FILE" build backend frontend worker dagster-webserver dagster-daemon

log "restarting services"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

wait_for_container_health backend 180
wait_for_container_health frontend 120

log "checking backend liveness"
docker compose -f "$COMPOSE_FILE" exec -T backend curl -fsS http://localhost:8000/health/live >/dev/null

log "checking backend readiness"
docker compose -f "$COMPOSE_FILE" exec -T backend curl -fsS http://localhost:8000/health/ready >/dev/null

log "checking frontend"
docker compose -f "$COMPOSE_FILE" exec -T frontend wget --no-verbose --no-check-certificate --tries=1 --spider https://127.0.0.1/ >/dev/null

log "service status"
docker compose -f "$COMPOSE_FILE" ps

log "deployment complete"
