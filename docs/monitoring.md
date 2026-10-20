# پایش، هشدار، بکاپ و بازیابی

> مخاطب: اپراتور/On-call و تیم پلتفرم. مرجع معماری: [architecture.md](./architecture.md) §5–§7؛ مدل تهدید و هشدارهای امنیتی: [security.md](./security.md) §9–§12؛ رسیدگی به حادثه: [runbooks/incidents.md](./runbooks/incidents.md).

این سند قرارداد عملیاتی API را تعریف می‌کند: متریک‌ها، لاگ ساختاریافته، Probeها، قواعد هشدار، داشبورد و روش بکاپ/بازیابی. همهٔ نام متریک‌ها و برچسب‌ها بخشی از قرارداد هستند؛ تغییرشان باید همراه با به‌روزرسانی این سند، `deploy/observability/` و تست‌های `promtool` باشد.

## 1. Endpointهای عملیاتی

| مسیر       | نوع        | دسترسی                           | رفتار                                                                                                     |
| ---------- | ---------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/healthz` | Liveness   | عمومی (پشت Proxy)                | فقط زنده‌بودن فرایند؛ **هیچ** وابستگی را بررسی نمی‌کند و هیچ Query/اتصال نمی‌گیرد.                        |
| `/readyz`  | Readiness  | داخلی / Load Balancer            | هر Probe با Timeout پیش‌فرض ۱٫۵ ثانیه؛ اگر یکی Down باشد `503` با `status: "degraded"` برمی‌گرداند.       |
| `/metrics` | Prometheus | فقط شبکهٔ داخلی (اختیاری Bearer) | بسته به `METRICS_ENABLED`؛ بدون آن `404`. در صورت تنظیم `METRICS_TOKEN` فقط با `Authorization: Bearer …`. |

- `/readyz` همیشه نتیجهٔ تازه می‌گیرد (`fresh`). `/metrics` برای جلوگیری از فشار روی دیتابیس، نتیجهٔ Probe وابستگی‌ها را حداکثر ۱۰ ثانیه Cache می‌کند.
- هرگز `/metrics` را روی Ingress عمومی منتشر نکنید. اگر Proxy نمی‌تواند محدودیت شبکه را اعمال کند، `METRICS_TOKEN` (حداقل ۱۶ کاراکتر) را از KMS/Vault تنظیم کنید. مقایسهٔ توکن با `timingSafeEqual` انجام می‌شود.
- `X-Request-Id` در همهٔ پاسخ‌ها برگردانده می‌شود؛ مقدار معتبر ورودی (`[A-Za-z0-9._:-]{8,128}`) حفظ و در غیر این صورت UUID تولید می‌شود.

### پیکربندی

| متغیر                | پیش‌فرض | توضیح                                                                          |
| -------------------- | ------- | ------------------------------------------------------------------------------ |
| `METRICS_ENABLED`    | `false` | فعال‌سازی `/metrics`. مقدار `false` صریحاً `false` تفسیر می‌شود.               |
| `METRICS_TOKEN`      | —       | توکن Bearer اختیاری برای Scrape؛ حداقل ۱۶ کاراکتر، از KMS/Vault.               |
| `BACKUP_STATUS_FILE` | —       | فایل JSON وضعیت بکاپ؛ منبع متریک `idpn_backup_last_success_timestamp_seconds`. |
| `LOG_LEVEL`          | `info`  | سطح لاگ ساختاریافته (`silent` برای خاموش‌کردن).                                |

## 2. قرارداد متریک‌ها

همهٔ متریک‌ها پیشوند `idpn_` دارند و از نوع Counter/Gauge/Histogram استاندارد Prometheus هستند. برچسب `route` همیشه **الگوی Route** است (نه URL خام)؛ برای درخواست بدون Route مقدار `unmatched` می‌گیرد. سقف هر متریک ۱۰۰۰ سری برچسب است و سری‌های اضافی در `idpn_metrics_series_dropped_total` شمرده می‌شوند.

| متریک                                        | نوع       | برچسب‌ها                    | معنا                                                                               |
| -------------------------------------------- | --------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `idpn_http_requests_total`                   | Counter   | `method`, `route`, `status` | همهٔ درخواست‌های Route‌شده (به‌جز `/healthz`، `/readyz`، `/metrics`).              |
| `idpn_http_request_duration_seconds`         | Histogram | `method`, `route`, `status` | تأخیر درخواست؛ Bucketها حول SLO ۳۰۰ms.                                             |
| `idpn_auth_failures_total`                   | Counter   | `route`, `reason`           | `invalid_client`، `login_failed`، `forbidden`، `unauthenticated`، `invalid_token`. |
| `idpn_token_requests_total`                  | Counter   | `grant_type`, `result`      | نتیجهٔ `/oauth2/token`.                                                            |
| `idpn_tokens_issued_total`                   | Counter   | `grant_type`                | پاسخ موفق Token.                                                                   |
| `idpn_token_refresh_total`                   | Counter   | `result`                    | موفق/ناموفق بودن Refresh Grant.                                                    |
| `idpn_refresh_token_reuse_detected_total`    | Counter   | —                           | استفادهٔ مجدد از Refresh Token چرخیده (خانواده Revoke شده).                        |
| `idpn_token_revocations_total`               | Counter   | —                           | درخواست‌های Revoke پذیرفته‌شده.                                                    |
| `idpn_backchannel_logout_total`              | Counter   | `status`                    | `delivered`، `queued`، `skipped`، `failed`.                                        |
| `idpn_active_sessions`                       | Gauge     | —                           | Sessionهای فعال (غیر Revoke و غیر منقضی) در PostgreSQL.                            |
| `idpn_dependency_up`                         | Gauge     | `service`                   | `postgres`/`redis`: ۱ سالم، ۰ خراب (همان Probe لازم برای `/readyz`).               |
| `idpn_signing_key_age_days`                  | Gauge     | —                           | سن کلید فعال امضا.                                                                 |
| `idpn_signing_key_rotation_due`              | Gauge     | —                           | ۱ اگر از آستانهٔ چرخش (`KEY_ROTATION_INTERVAL_DAYS`) گذشته باشد.                   |
| `idpn_backchannel_queue_depth`               | Gauge     | —                           | طول صف پایدار `idpn:logout-queue` در Redis.                                        |
| `idpn_backup_last_success_timestamp_seconds` | Gauge     | —                           | زمان آخرین بکاپ موفق، از `BACKUP_STATUS_FILE`.                                     |
| `idpn_metrics_collector_errors_total`        | Counter   | `collector`                 | شکست یک جمع‌کننده در Scrape (بقیهٔ Gaugeها سالم می‌مانند).                         |
| `idpn_metrics_series_dropped_total`          | Counter   | —                           | سری‌های حذف‌شده پس از سقف ۱۰۰۰.                                                    |

نمونه:

```
idpn_http_requests_total{method="POST",route="/oauth2/token",status="200"} 42
idpn_dependency_up{service="postgres"} 1
idpn_signing_key_age_days 12
idpn_backchannel_queue_depth 0
```

هر تشخیص Reuse علاوه بر متریک، رویداد Audit با اکشن `token.refresh.reuse_detected` (`actorType=anonymous`، `clientId`، `metadata.revokedFamily`) ثبت می‌کند؛ توکن خام در Audit نیست.

## 3. لاگ ساختاریافته

خروجی API یک JSON در هر خط روی stdout است (Pino/Fastify). فیلدهای تضمین‌شده:

| فیلد              | مثال                       | توضیح                                                    |
| ----------------- | -------------------------- | -------------------------------------------------------- |
| `time`            | `2026-10-20T00:15:00.000Z` | ISO-8601 UTC.                                            |
| `level`           | `info`                     | رشته، نه عدد.                                            |
| `service`         | `on4net-idpn-api`          | نام سرویس.                                               |
| `pid`, `hostname` | —                          | برای همبستگی با کانتینر.                                 |
| `reqId`           | `433e084a-…`               | شناسهٔ درخواست؛ همان `X-Request-Id` پاسخ.                |
| `req.request_id`  | `433e084a-…`               | همان شناسه در شیء سریال‌شدهٔ `req` (برای جست‌وجوی آسان). |
| `method`, `url`   | `POST`, `/oauth2/token?…`  | URL با مقادیر حساس Query حذف‌شده (`redacted`).           |
| `route`           | `/oauth2/token`            | الگوی Route یا `unmatched`.                              |
| `remote_address`  | `10.0.0.5`                 | آدرس کلاینت (پشت Proxy، IP پروکسی تا تنظیم Trust).       |
| `statusCode`      | `200`                      | فقط وضعیت پاسخ.                                          |
| `msg`             | `request completed`        | پیام ثابت/بدون PII.                                      |

- **هدرها و Body هرگز لاگ نمی‌شوند**؛ Serializer فقط Allowlist بالا را می‌نویسد. لایهٔ دوم `redact` مسیرهایی مانند `req.headers.authorization`، `req.headers.cookie`، `res.headers["set-cookie"]`، `password`، `client_secret`، `refresh_token`، `access_token`، `id_token`، `code`، `otp` را با `[redacted]` جایگزین می‌کند. پیام و Stack خطاها نیز قبل از نوشتن از Credentialهای URL و `key=value`های حساس پاک و محدود می‌شوند.
- خطاهای Back-channel فقط `clientId` و `phase` را لاگ می‌کنند، نه Logout Token.
- برای حمل لاگ‌ها به Loki از Docker logging driver `loki` یا Grafana Alloy استفاده کنید؛ هیچ فیلتر «امیدوارانه»ای جای Redaction در API را نمی‌گیرد.
- همبستگی: `reqId`/`req.request_id` را در پاسخ به کاربر/پشتیبانی بگیرید (هدر `X-Request-Id`) و در Loki جست‌وجو کنید.

## 4. اجرای محلی Prometheus / Grafana / Loki

پیش‌نیاز: API روی `127.0.0.1:3000` با `METRICS_ENABLED=true` در حال اجرا باشد و `docker compose up -d postgres redis` سرویس‌های stateful را بالا آورده باشد.

```powershell
$env:METRICS_ENABLED = 'true'
$env:BACKUP_STATUS_FILE = 'artifacts/backup-drill/status.json'
pnpm --filter @idpn/api start

Copy-Item deploy/observability/.env.example deploy/observability/.env
# GRAFANA_ADMIN_PASSWORD را در .env عوض کنید
docker compose --env-file deploy/observability/.env `
  -f deploy/observability/compose.observability.yaml config --quiet
docker compose --env-file deploy/observability/.env `
  -f deploy/observability/compose.observability.yaml up -d
```

| سرویس      | آدرس                          | نکته                                                             |
| ---------- | ----------------------------- | ---------------------------------------------------------------- |
| Prometheus | <http://127.0.0.1:9090>       | `Status → Targets` باید `idpn-api` را `UP` نشان دهد.             |
| Grafana    | <http://127.0.0.1:3003>       | داشبورد `IDPN / on4net IDPN — Overview` خودکار Provision می‌شود. |
| Loki       | <http://127.0.0.1:3100/ready> | Datasource `idpn-loki` در Grafana آماده است.                     |

`deploy/observability/prometheus/prometheus.yml` فقط از طریق `host.docker.internal` به API روی هاست وصل می‌شود؛ API لازم نیست روی `0.0.0.0` گوش دهد. برای هشدار دیسک، Profile اختیاری `node-exporter` را روی هاست Linux فعال کنید (Docker Desktop ریشهٔ هاست را Mount نمی‌کند).

اعتبارسنجی بدون بالا آوردن Stack:

```powershell
docker run --rm -v "${PWD}/deploy/observability/prometheus:/etc/prometheus:ro" `
  --entrypoint promtool prom/prometheus:v3.1.0 check config /etc/prometheus/prometheus.yml
docker run --rm -v "${PWD}/deploy/observability/prometheus:/rules:ro" `
  --entrypoint promtool prom/prometheus:v3.1.0 check rules /rules/alerts.yml
docker run --rm -v "${PWD}/deploy/observability/prometheus:/rules:ro" `
  --entrypoint promtool prom/prometheus:v3.1.0 test rules /rules/alerts.test.yaml
docker compose --env-file deploy/observability/.env.example `
  -f deploy/observability/compose.observability.yaml config --quiet
```

`alerts.test.yaml` با `promtool test rules` ثابت می‌کند هر هشدار روی شرط مستند **Firing** می‌شود (شامل Error Rate، p95، Auth Spike، Dependency Down، Refresh Reuse، Key Age، Queue Backlog، Backup Stale، Disk Low و Missing Backup Metric).

## 5. قواعد هشدار

| هشدار                             | شرط                                              | Severity | Runbook                                                             |
| --------------------------------- | ------------------------------------------------ | -------- | ------------------------------------------------------------------- |
| `IdpnApiUnavailable`              | `up{job="idpn-api"} == 0` برای ۲ دقیقه           | critical | [incidents §2](./runbooks/incidents.md#2-api-down-or-unavailable)   |
| `IdpnApiErrorRateHigh`            | نسبت 5xx > ۲٪ برای ۵ دقیقه                       | warning  | [§3](./runbooks/incidents.md#3-elevated-error-rate)                 |
| `IdpnApiLatencyP95High`           | p95 > 300ms برای ۱۰ دقیقه                        | warning  | [§3.1](./runbooks/incidents.md#31-latency-regression)               |
| `IdpnDependencyDown`              | `idpn_dependency_up == 0` برای ۲ دقیقه           | critical | [§4](./runbooks/incidents.md#4-dependency-down-postgresql-or-redis) |
| `IdpnAuthFailureSpike`            | نرخ خطای احراز هویت > ۵/ثانیه برای ۵ دقیقه       | warning  | [§5](./runbooks/incidents.md#5-brute-force-or-credential-stuffing)  |
| `IdpnRefreshTokenReuseDetected`   | هر افزایش در ۵ دقیقه                             | critical | [§6](./runbooks/incidents.md#6-refresh-token-reuse)                 |
| `IdpnSigningKeyRotationDue`       | `idpn_signing_key_rotation_due == 1` برای ۱ ساعت | warning  | [§7](./runbooks/incidents.md#7-signing-key-rotation)                |
| `IdpnSigningKeyTooOld`            | سن کلید > ۹۰ روز برای ۱ ساعت                     | warning  | [§7](./runbooks/incidents.md#7-signing-key-rotation)                |
| `IdpnBackchannelQueueBacklog`     | عمق صف > ۱۰۰ برای ۱۰ دقیقه                       | warning  | [§8](./runbooks/incidents.md#8-back-channel-logout-backlog)         |
| `IdpnBackchannelDeliveryFailures` | نرخ `status="failed"` > ۰٫۱/ثانیه                | warning  | [§8](./runbooks/incidents.md#8-back-channel-logout-backlog)         |
| `IdpnBackupStale`                 | آخرین بکاپ > ۳۶ ساعت                             | critical | [§9](./runbooks/incidents.md#9-backup-failure)                      |
| `IdpnBackupMetricMissing`         | متریک بکاپ وجود ندارد (۶ ساعت)                   | warning  | [§9](./runbooks/incidents.md#9-backup-failure)                      |
| `IdpnDiskSpaceLow`                | فضای آزاد < ۱۵٪                                  | warning  | [§10](./runbooks/incidents.md#10-disk-space)                        |
| `IdpnDiskWillFillSoon`            | پیش‌بینی پر شدن در ۴ ساعت                        | warning  | [§10](./runbooks/incidents.md#10-disk-space)                        |

## 6. بکاپ و بازیابی

### 6.1 ابزار

```powershell
# بکاپ PostgreSQL (custom format) + RDB از Redis + manifest + sha256 + وضعیت تازگی
pnpm --filter @idpn/api run ops:backup -- `
  --database-url "postgresql://idpn:***@127.0.0.1:55440/idpn" `
  --redis-url "redis://127.0.0.1:56380" `
  --output-dir backups --retention-days 14

# Drill: ساخت دیتابیس Scratch، Restore، مقایسهٔ تعداد سطرها، اندازه‌گیری RTO، حذف Scratch
pnpm --filter @idpn/api run ops:restore -- `
  --backup backups/postgres-idpn-<timestamp>.dump `
  --drill --source-url "postgresql://idpn:***@127.0.0.1:55440/idpn" --json
```

- `pg_dump`/`pg_restore`/`psql` اگر نصب باشند مستقیم استفاده می‌شوند؛ در غیر این صورت همان Image پین‌شدهٔ `postgres:16-alpine` (همان نسخهٔ Compose) با `host.docker.internal` استفاده می‌شود. نسخهٔ ابزار نباید از سرور قدیمی‌تر باشد؛ با `OPS_PG_MODE=local|docker|auto` انتخاب را اجباری کنید (CI مقدار `docker` دارد).
- رمز اتصال از URL جدا می‌شود و از طریق `PGPASSWORD`/`REDISCLI_AUTH` به ابزار می‌رسد؛ بنابراین در `ps`/Command line دیده نمی‌شود. در تولید ترجیحاً از `PGPASSFILE` و کاربر بکاپ با حداقل دسترسی (`SELECT`/`pg_read_all_data`) استفاده کنید.
- Redis: اگر `redis-cli` نباشد، `BGSAVE` در کانتینر (`--redis-container`، پیش‌فرض `idpn-redis`) اجرا و `dump.rdb` کپی می‌شود؛ سپس `redis-check-rdb` آن را اعتبارسنجی می‌کند. بازگردانی Redis: Redis را متوقف کنید، `dump.rdb` را در Data Directory جای‌گذاری کنید (همان Major Version) و Redis را بالا بیاورید؛ سپس `DBSIZE` را بررسی کنید. Redis فقط Session/Rate-Limit/صف است؛ از دست رفتنش کاربران را مجبور به ورود دوباره می‌کند ولی هویت/کلاینت/Audit را از بین نمی‌برد.
- `status.json` نوشته می‌شود و API با `BACKUP_STATUS_FILE` آن را به `idpn_backup_last_success_timestamp_seconds` تبدیل می‌کند؛ هشدار `IdpnBackupStale` روی همین متریک است.

### 6.2 یکپارچگی، رمزنگاری و نگهداشت

- برای هر فایل `<file>.sha256` با قالب `<hex>  <name>` نوشته می‌شود. `ops:restore` قبل از هر کاری Checksum را بررسی می‌کند و در صورت عدم تطابق متوقف می‌شود (`--skip-checksum` فقط برای بازیابی اضطراری و با تأیید دو نفر).
- رمزنگاری در حالت سکون: `--age-recipient age1…` هر فایل را با `age` رمز می‌کند (فایل Plain حذف می‌شود)؛ برای بازیابی `--age-identity` بدهید. در محیط تولید کلیدخصوصی `age` در KMS/Vault باشد و بکاپ روی Volume/Object Storage رمزنگاری‌شده (AES-256) نگهداری شود. هرگز بکاپ را در Git یا Bucket عمومی نگذارید (`backups/` در `.gitignore` است).
- نگهداشت پیش‌فرض ۱۴ روز است (`--retention-days`). فقط فایل‌هایی که خود ابزار با پیشوند `postgres-`/`redis-`/`manifest-` ساخته حذف می‌شوند؛ سایر فایل‌های پوشه دست‌نخورده می‌مانند.
- Manifest شامل زمان، دیتابیس، اهداف، اندازه، SHA-256 و وضعیت رمزنگاری است و خودش هم Checksum دارد.
- بازگردانی واقعی به دیتابیس موجود فقط با `--allow-non-scratch` انجام می‌شود؛ بدون این Flag فقط نام‌هایی که صریحاً `restore`/`drill`/`scratch`/`test` دارند پذیرفته می‌شوند و Restore روی خودِ دیتابیس ممنوع است.

### 6.3 RPO / RTO

| هدف | مقدار سند  | مکانیزم این تغییر                                                                                                                   | وضعیت                                                                    |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| RPO | ≤ ۱۵ دقیقه | Dump منطقی طبق زمان‌بندی Job؛ برای ۱۵ دقیقه باید WAL Archiving (pgBackRest/WAL-G) یا اجرای Dump هر ۱۵ دقیقه در محیط تولید فعال شود. | **نیازمند پیکربندی محیط تولید** (اسکریپت به‌تنهایی RPO را تضمین نمی‌کند) |
| RTO | ≤ ۱ ساعت   | Restore کامل + اعتبارسنجی تعداد سطرها؛ Drill محلی حدود ۲۱ ثانیه برای دیتابیس تست اندازه گرفت.                                       | تأییدشده در Drill محلی                                                   |

### 6.4 نتیجهٔ Drill ثبت‌شده (۲۰۲۶-۱۰-۲۰)

```
backup: postgres-idpn-20261020T004008Z.dump (2.2 MiB, sha256 d44d6bdf…)
        redis-idpn-20261020T004008Z.rdb (8.8 KiB, sha256 313975ec…, redis-check-rdb OK)
restore drill: checksum verified; scratch DB idpn_restore_drill_20261020t004011
verified 11 tables, RTO 20.98s, then dropped the scratch DB
users=255/255, clients=7/7, sessions=762/762, refresh_tokens=7870/7870,
authorization_codes=16521/16521, audit_events=791/791
```

این Drill در `api/test/backup-restore.integration.test.ts` (با `TEST_DATABASE_URL`) و Job `observability` در CI هم اجرا می‌شود.

## 7. CI

Job `observability` در `.github/workflows/ci.yml` این‌ها را اجرا می‌کند:

```text
promtool check config /etc/prometheus/prometheus.yml
promtool check rules /rules/alerts.yml
promtool test rules /rules/alerts.test.yaml
node -e "JSON.parse(...)"                       # Grafana dashboard
docker compose ... config --quiet               # observability overlay
vitest run src/observability test/observability.test.ts test/ops-scripts.test.ts
db:deploy + db:seed
GET /healthz, /readyz (200), /metrics (401 without token, 200 with token)
ops:backup + ops:restore --drill
```

## 8. شکاف شناخته‌شده

- **OpenTelemetry Tracing** هنوز صادر نمی‌شود. همبستگی فعلی از طریق `X-Request-Id` و لاگ JSON است؛ افزودن SDK/Tracer و سرویس Collector نیازمند تغییر وابستگی و کار جداگانه است و در این تغییر انجام نشده است.
- هشدار دیسک به `node_exporter` نیاز دارد و در Docker Desktop ویندوز قابل اجرا نیست (روی هاست Linux یا Kubernetes فعال کنید).
