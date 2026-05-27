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

get_env_file_value() {
  local name="$1"

  awk -F= -v key="$name" '
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
        print value
        found = 1
        exit
      }
    }
    END { exit found ? 0 : 1 }
  ' .env
}

require_env_file_value() {
  local name="$1"

  if ! value="$(get_env_file_value "$name")"; then
    fail "missing required variable in .env: $name"
  fi

  if [ -z "$value" ]; then
    fail "required variable is empty in .env: $name"
  fi
}

require_env_not_default() {
  local name="$1"
  local value=""

  value="$(get_env_file_value "$name")" || fail "missing required variable in .env: $name"

  case "$value" in
    "password123"|"postgres123"|"redis123"|"clickhouse123"|"change-me-in-production"|"change-me-in-production-use-a-long-random-secret"|"your_etherscan_api_key_here"|"your_alchemy_api_key_here"|"<required-in-prod>")
      fail "unsafe default value detected for $name in .env"
      ;;
  esac

  case "$value" in
    "<"*">")
      fail "placeholder value detected for $name in .env"
      ;;
  esac
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
  require_env_not_default "$name"
done

ingest_source="$(get_env_file_value INGEST_SOURCE || true)"
ingest_source="${ingest_source:-}"
etherscan_api_key="$(get_env_file_value ETHERSCAN_API_KEY || true)"
alchemy_api_key="$(get_env_file_value ALCHEMY_API_KEY || true)"

case "$ingest_source" in
  ""|"etherscan")
    if [ -z "$etherscan_api_key" ]; then
      fail "ETHERSCAN_API_KEY is required when INGEST_SOURCE is unset or etherscan"
    fi
    require_env_not_default ETHERSCAN_API_KEY
    ;;
  "alchemy")
    if [ -z "$alchemy_api_key" ]; then
      fail "ALCHEMY_API_KEY is required when INGEST_SOURCE=alchemy"
    fi
    require_env_not_default ALCHEMY_API_KEY
    ;;
  "mock")
    ;;
  *)
    fail "INGEST_SOURCE must be etherscan, alchemy, mock, or empty"
    ;;
esac

previous_commit="$(git rev-parse --short HEAD)"
log "previous commit: ${previous_commit}"
log "syncing ${release_branch}"

git fetch origin "$release_branch"
git checkout "$release_branch"
git reset --hard "origin/$release_branch"

# The worker and backend images build from the etl-rs submodule; a bare reset
# leaves it stale, so sync it to the committed SHA. etl-rs is public, so this
# clones over HTTPS without credentials. `sync` rewrites any stale local
# submodule URL from .gitmodules.
log "syncing submodules"
git submodule sync --recursive
git submodule update --init --recursive

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
