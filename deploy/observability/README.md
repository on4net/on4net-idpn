# Observability stack

Prometheus, Grafana and Loki for the on4net IDPN API. The full operator guide — metric
catalog, log fields, alert thresholds, backup/restore and RPO/RTO — is
[`docs/monitoring.md`](../../docs/monitoring.md); incident handling is
[`docs/runbooks/incidents.md`](../../docs/runbooks/incidents.md).

## Start the API with metrics

```powershell
# Stateful services from the repository root compose file
docker compose up -d postgres redis

$env:METRICS_ENABLED = 'true'
# Optional: require this token on /metrics (>= 16 characters)
$env:METRICS_TOKEN = 'local-metrics-token-0123456789'
# Backups write this file; the API exposes its timestamp as a freshness gauge
$env:BACKUP_STATUS_FILE = 'artifacts/backup-drill/status.json'
pnpm --filter @idpn/api start
```

When `METRICS_TOKEN` is set, Prometheus must send it. Uncomment `authorization` in
`prometheus/prometheus.yml` and mount a token file (never commit it):

```yaml
authorization:
  type: Bearer
  credentials_file: /etc/prometheus/metrics-token
```

## Start Prometheus, Grafana and Loki

```powershell
Copy-Item deploy/observability/.env.example deploy/observability/.env
# edit GRAFANA_ADMIN_PASSWORD first
docker compose --env-file deploy/observability/.env `
  -f deploy/observability/compose.observability.yaml config --quiet
docker compose --env-file deploy/observability/.env `
  -f deploy/observability/compose.observability.yaml up -d
```

- Prometheus: <http://127.0.0.1:9090> — check `Status → Targets` (`idpn-api` must be `UP`).
- Grafana: <http://127.0.0.1:3003> — the `IDPN / on4net IDPN — Overview` dashboard is
  provisioned from `grafana/dashboards/idpn-overview.json`.
- Loki: <http://127.0.0.1:3100/ready> — datasource `idpn-loki` is provisioned. Ship the API
  stdout logs with the Docker `loki` logging driver or Grafana Alloy (see
  `docs/monitoring.md`); the API only logs redacted JSON.

## Validate without starting the stack

```powershell
docker run --rm -v "${PWD}/deploy/observability/prometheus:/etc/prometheus:ro" `
  --entrypoint promtool prom/prometheus:v3.1.0 check config /etc/prometheus/prometheus.yml
docker run --rm -v "${PWD}/deploy/observability/prometheus:/rules:ro" `
  --entrypoint promtool prom/prometheus:v3.1.0 check rules /rules/alerts.yml
docker run --rm -v "${PWD}/deploy/observability/prometheus:/rules:ro" `
  --entrypoint promtool prom/prometheus:v3.1.0 test rules /rules/alerts.test.yaml
docker compose -f deploy/observability/compose.observability.yaml config --quiet
```

CI runs the same commands in the `observability` job.
