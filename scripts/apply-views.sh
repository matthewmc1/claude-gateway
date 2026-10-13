#!/usr/bin/env bash
# Create/refresh the ClickHouse analytics views. Safe to re-run.
# Requires the collector to have written at least once (it creates the tables).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

docker compose exec -T clickhouse clickhouse-client \
  --user otel --password "$CLICKHOUSE_PASSWORD" --multiquery < clickhouse/views.sql
echo "views applied."
