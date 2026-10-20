# Runbook — پاسخ به حادثه

> مخاطب: On-call و تیم امنیت/پلتفرم. سیگنال‌ها و آستانه‌ها: [monitoring.md](../monitoring.md). مدل تهدید: [security.md](../security.md). Rollback اپ/کلاینت: [app-onboarding.md](./app-onboarding.md).

هدف این Runbook این است که در ۵ دقیقهٔ اول، شدت حادثه و «مالک اقدام» مشخص شود و شواهد از بین نرود. هیچ‌جا رمز، توکن، Cookie یا Secret را در چت/تیکت کپی نکنید؛ فقط شناسهٔ فنی (مثل `kids`، `client_id`، `request_id`، `sid` هش‌شده) را به اشتراک بگذارید.

## 0. شدت‌ها

| سطح      | تعریف                                                    | نمونه                                                            | زمان پاسخ اولیه | ارتباط                                       |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------- | --------------- | -------------------------------------------- |
| **SEV1** | قطع کامل ورود/توکن برای همه یا نشت/سوءاستفادهٔ کلید امضا | API Down، Postgres Down، Key Compromise                          | ≤ ۵ دقیقه       | اعلان فوری به مالک محصول/امنیت + Status Page |
| **SEV2** | تخریب گسترده ولی محدود (یک مسیر/یک اپ)                   | Error Rate > ۲٪، Latency p95 > 300ms، Back-channel Backlog       | ≤ ۱۵ دقیقه      | کانال Incident + به‌روزرسانی هر ۳۰ دقیقه     |
| **SEV3** | ریسک امنیتی یا عملیاتی بدون قطعی                         | Refresh Reuse، Brute Force Spike، Backup Stale، Key Rotation Due | ≤ ۱ ساعت        | تیکت + بررسی در همان روز                     |
| **SEV4** | هشدار ظرفیت/نگهداشت                                      | Disk Low، Backup Metric Missing                                  | ≤ ۱ روز کاری    | تیکت                                         |

اگر شک دارید، سطح را **بالاتر** بگیرید و بعد پایین بیاورید. تغییر سطح را در تایم‌لاین ثبت کنید.

## 1. پنج دقیقهٔ اول (همهٔ سناریوها)

1. **تأیید حادثه**: `IdpnApiUnavailable` یا `IdpnDependencyDown` را با Scrape واقعی تأیید کنید، نه فقط Dashboard.
   ```powershell
   curl -fsS http://127.0.0.1:3000/healthz
   curl -fsS -o readyz.json -w '%{http_code}' http://127.0.0.1:3000/readyz
   docker compose ps
   docker logs --tail 200 idpn-postgres
   docker logs --tail 200 idpn-redis
   ```
2. **ثبت زمان شروع و شناسهٔ حادثه** در کانال Incident (UTC). از این لحظه هر اقدام با زمان ثبت شود.
3. **حفظ شواهد**: لاگ‌های API (JSON stdout) و Proxy را Export کنید؛ خروجی `docker inspect`/`ps` و `readyz.json` را نگه دارید. سرویس را Restart نکنید مگر برای مهار (Containment) و در آن صورت دلیل را بنویسید.
4. **محدودکردن شعاع**: اگر مشکل امنیتی است، کلاینت/کاربر/کلید مرتبط را شناسایی و در صورت لزوم Session/Refresh را Revoke کنید (نه کل سرویس).
5. **ارتباط**: یک نفر مسئول ارتباط شود؛ حداقل «چه چیزی، از کِی، تأثیر، اقدام بعدی» را اعلام کنید.

> هرگز برای «سریع‌تر شدن» لاگ را با `LOG_LEVEL=debug` در تولید بالا نبرید مگر با تأیید امنیتی؛ و هرگز Redaction را غیرفعال نکنید.

## 2. API down or unavailable

هشدار: `IdpnApiUnavailable`.

**بررسی**: `up{job="idpn-api"}==0`، پاسخ `/healthz`، وضعیت کانتینر/Process، پورت (`HOST`/`PORT`)، خطای Crash در لاگ (مثلاً `EnvValidationError` یا کلید امضا).

**اقدام**:

1. اگر Process بالا نیست: `docker compose ps` و در استقرار Compose، `docker compose up -d api` (یا Restart سرویس در Orchestrator). اگر Crash Loop است، **علت** را بخوانید: پیکربندی نامعتبر، نبود `SOCIAL_SECRET_KEY`/`MFA_SECRET_KEY` در تولید، یا دسترسی نداشتن به Redis/Postgres.
2. اگر `/healthz` سالم ولی `/readyz` ۵۰۳ است، به §4 بروید (وابستگی).
3. اگر چند Replica دارید، ترافیک را از Replica خراب بردارید و همان را دیباگ کنید.
4. **Rollback**: اگر بعد از Deploy رخ داد، به Image/Commit قبلی برگردید (روش Rollback همان Pipeline؛ برای داده/کلاینت [app-onboarding.md](./app-onboarding.md)). Migration را بدون تأیید برنگردانید.

**شواهد**: زمان آخرین Deploy، Commit، خروجی `/readyz`، لاگ ۲۰۰ خط آخر، وضعیت Disk/DB.

## 3. Elevated error rate

هشدار: `IdpnApiErrorRateHigh`.

**بررسی**: متریک `idpn_http_requests_total` را بر اساس `route`/`status` تفکیک کنید؛ آیا خطا در `/oauth2/token`، `/api/v1/login` یا یک مسیر Admin است؟ `idpn_metrics_collector_errors_total` را هم ببینید.

**اقدام**:

1. اگر خطا ۵xx از یک وابستگی است → §4.
2. اگر فقط یک Route خراب است، همان Route را با Feature Flag/Deploy قبلی برگردانید.
3. اگر ۴۰۱/۴۰۳ زیاد است، §5 را بررسی کنید (حمله یا پیکربندی Client).
4. خطای ۴۲۹ (Rate Limit) را با خطای ۵xx اشتباه نگیرید؛ Rate Limiter در Redis است و از کار افتادن آن رفتار Fail-open/closed دارد (طبق پیاده‌سازی همان Route).

### 3.1 Latency regression

هشدار: `IdpnApiLatencyP95High`.

1. `histogram_quantile` را به تفکیک `route` و `status` ببینید (داشبورد «Latency p50/p95» و `idpn_http_request_duration_seconds_bucket`).
2. اگر فقط `/oauth2/token` کند است: Argon2/Client Secret verification، وضعیت Pool دیتابیس و Queryهای Refresh را بررسی کنید؛ SLO سند p95 < 300ms است.
3. اگر همهٔ Routeها کند شده‌اند: CPU/حافظهٔ Node، اتصال Redis/Postgres، یا افزایش ناگهانی ترافیک را بررسی کنید. برای جلوگیری از اشباع، در صورت وجود Replica مقیاس افقی بدهید و سپس ریشه را پیدا کنید.
4. `idpn_metrics_collector_errors_total` و زمان Scrape را ببینید؛ کندی Collector نباید با کندی API اشتباه شود.

## 4. Dependency down: PostgreSQL or Redis

هشدار: `IdpnDependencyDown` (برچسب `service`).

**PostgreSQL**:

1. `pg_isready`، فضای دیسک، اتصال‌ها (`pg_stat_activity`) و لاگ سرور را ببینید. از `docker exec idpn-postgres pg_isready -U idpn -d idpn` استفاده کنید.
2. اگر Connection Pool پر است، Queryهای طولانی/قفل‌ها را بررسی کنید و در صورت نیاز فقط Sessionهای بلااستفاده را ببندید.
3. `/readyz` باید ۵۰۳ بدهد؛ Load Balancer نباید ترافیک بفرستد. **API را سالم اعلام نکنید** تا `/readyz` سبز شود.
4. بازیابی از بکاپ: §9 (فقط با تأیید Incident Commander).

**Redis**:

1. `redis-cli ping`، حافظه (`INFO memory`)، AOF/RDB (`INFO persistence`) را ببینید.
2. Redis برای Session/Rate-Limit/صف است؛ در قطعی، ورودهای جدید و Refresh ممکن است شکست بخورند. **Session را در DB جعل نکنید.**
3. پس از بازگشت Redis، Sessionهای قدیمی ممکن است از دست رفته باشند؛ کاربران باید دوباره وارد شوند. Audit `session.revoked` را برای توضیح به پشتیبانی بررسی کنید.
4. صف Back-channel در Redis است؛ اگر Redis از بکاپ برگشت، §8 را بررسی کنید تا Logoutهای ازدست‌رفته دوباره ارسال شوند.

## 5. Brute force or credential stuffing

هشدار: `IdpnAuthFailureSpike`.

**بررسی**: `idpn_auth_failures_total` را بر اساس `route`/`reason` و لاگ Audit (`user.login.failed`) تفکیک کنید؛ IPها و `client_id`ها را همبستگی دهید. الگوی «چند IP، یک Username» یا «یک IP، چند Username» را ثبت کنید.

**اقدام**:

1. Rate Limit را برای همان IP/Client سخت‌تر کنید (پیکربندی موجود؛ مقادیر را بدون تأیید تغییر ندهید).
2. حساب‌های هدف را قفل/Step-up کنید اگر سیاست اجازه می‌دهد؛ **حساب را حذف نکنید**.
3. اگر منشأ یک Client/App است، `client_secret` آن را بچرخانید (روش امن در [app-onboarding.md](./app-onboarding.md)).
4. Audit و Access Log را حفظ کنید؛ برای بررسی قانونی، Export با مجوز `idp:audit:read` و ثبت خود Export.

## 6. Refresh token reuse

هشدار: `IdpnRefreshTokenReuseDetected`.

این هشدار یعنی یک Refresh Token چرخیده دوباره ارائه شده و خانوادهٔ آن **قبلاً** Revoke شده است. می‌تواند نشانهٔ سرقت توکن باشد.

**اقدام**:

1. در Audit به دنبال `token.refresh.reuse_detected` بگردید (زمان، `client_id`، `metadata.revokedFamily`). توکن خام هرگز در Audit نیست.
2. تمام Sessionهای کاربر هدف را Revoke کنید (`POST /api/v1/users/{id}/logout-all` یا `DELETE /api/v1/sessions/{sid}` برای یک Session) و به کاربر اطلاع دهید.
3. اگر الگو چند کاربر/یک Client را درگیر می‌کند، Client را در وضعیت محدود قرار دهید و Secret آن را بچرخانید.
4. علت ریشه‌ای را بررسی کنید: نشت توکن در لاگ/مرورگر، کد اشتباه Client که هم‌زمان Refresh می‌کند، یا بدافزار. Race مشروع Client نیز ممکن است Reuse ایجاد کند؛ الگو را با یک کاربر تکرارشدنی جدا کنید.

## 7. Signing key rotation

هشدارها: `IdpnSigningKeyRotationDue`، `IdpnSigningKeyTooOld`.

**چرخش عادی** (کلید قدیمی در JWKS می‌ماند تا Tokenها منقضی شوند):

```powershell
# با مجوز idp:key:write و Step-up ادمین
curl -X POST https://auth.example.com/api/v1/keys/rotate `
  -H "Authorization: Bearer <admin-access-token>" `
  -H "Content-Type: application/json" -d '{"revokePrevious":false}'
```

- پس از چرخش، `/.well-known/jwks.json` را بررسی کنید و `idpn_signing_key_age_days` باید صفر شود.
- اگر Scheduler خاموش است (`KEY_ROTATION_INTERVAL_DAYS=0`)، چرخش دستی بالا تنها راه است.

**کلید به‌سرقت‌رفته / Compromise** (SEV1):

1. **فوراً** با `revokePrevious: true` بچرخانید تا Tokenهای امضاشده با کلید قدیمی بی‌اعتبار شوند.
2. تمام Sessionها و Refresh Tokenهای مؤثر را Revoke کنید (Global Logout برای کاربران حساس/ادمین‌ها).
3. Audit `key.rotate` و `kid` قدیمی/جدید را ثبت کنید. کلید خصوصی را از Secret Store حذف کنید و مطمئن شوید در بکاپ/لاگ نیست.
4. اگر کلید در KMS/Vault بوده، Access Log همان KMS را بررسی و دسترسی را محدود کنید.
5. به همهٔ Resource Serverها اطلاع دهید که JWKS را دوباره Fetch کنند (TTL کش JWKS حداکثر ۵ دقیقه است).

> چرخش با `revokePrevious:true` کاربران را مجبور به ورود مجدد می‌کند؛ این هزینه برای مهار نشت کلید پذیرفته است.

## 8. Back-channel logout backlog

هشدارها: `IdpnBackchannelQueueBacklog`، `IdpnBackchannelDeliveryFailures`.

**بررسی**:

```powershell
docker exec idpn-redis redis-cli LLEN idpn:logout-queue
curl -s -H "Authorization: Bearer <metrics-token>" http://127.0.0.1:3000/metrics | Select-String backchannel
```

لاگ‌های `component=backchannel-logout` را برای `phase=send|queue` ببینید (بدون توکن).

**اقدام**:

1. مقصد Client (`backchannelLogoutUri`) را بررسی کنید: DNS، TLS، پاسخ 2xx، و اینکه آدرس Private/Internal نباشد (SSRF Guard آدرس‌های Private را رد می‌کند).
2. اگر یک Client خراب است، با صاحب اپ تماس بگیرید و در صورت لزوم URI آن را موقتاً خالی کنید (Endpoint غیرفعال می‌شود)؛ این تصمیم محصولی است و باید ثبت شود.
3. صف را دستی خالی نکنید مگر با اسکریپت Retry مصوب؛ حذف پیام‌ها یعنی Logoutهای ازدست‌رفته و بدهی امنیتی.
4. پس از رفع، کاهش `idpn_backchannel_queue_depth` و نرخ `status="delivered"` را تأیید کنید.

## 9. Backup failure

هشدارها: `IdpnBackupStale`، `IdpnBackupMetricMissing`.

**بررسی**: `status.json`/`manifest-*.json` آخرین اجرا، فضای دیسک مقصد، دسترسی به Postgres/Redis و رمزنگاری (`age`/KMS) را ببینید. Job بکاپ را با همان دستور Runbook دوباره اجرا کنید و خروجی SHA-256 را ثبت کنید.

**اقدام**:

1. اگر بکاپ تازه شکست خورده، **بکاپ قدیمی را حذف نکنید** تا بکاپ جدید تأیید شود (Retention را دستی تغییر ندهید).
2. اگر دیتابیس از دست رفته، آخرین Dump معتبر را با `ops:restore --drill` روی یک Scratch تست کنید و سپس با `--allow-non-scratch` بازیابی کنید (تأیید Incident Commander).
3. RTO هدف ۱ ساعت است؛ زمان شروع/پایان Restore و تعداد سطرهای تأییدشده را در تایم‌لاین ثبت کنید.
4. پس از بازیابی: مهاجرت‌ها (`db:deploy`)، کلیدهای امضا (بکاپ کلید را از KMS بگیرید)، و Sessionها (Redis) را بررسی کنید؛ کاربران ممکن است نیاز به ورود دوباره داشته باشند.
5. علت را برطرف و Job را مانیتور کنید؛ `IdpnBackupMetricMissing` معمولاً یعنی `BACKUP_STATUS_FILE` در API تنظیم نشده یا فایل قابل خواندن نیست.

## 10. Disk space

هشدارها: `IdpnDiskSpaceLow`، `IdpnDiskWillFillSoon`.

1. مصرف را با `docker system df` و `du` روی Volumeهای `postgres-data`/`redis-data`/لاگ‌ها ببینید.
2. **هرگز** فایل‌های WAL/دیتابیس را برای آزادکردن فضا حذف نکنید. از Archiving/Retention پشتیبانی‌شده استفاده کنید.
3. بکاپ‌های قدیمی طبق سیاست Retention (پیش‌فرض ۱۴ روز) پاک شوند، نه فایل‌های دیتابیس.
4. لاگ‌های Docker را Rotate کنید (`log-opts max-size/max-file`) و حجم Loki/Prometheus را با Retention محدود کنید.
5. اگر فضا بحرانی است، نوشتن Audit را متوقف نکنید؛ ابتدا سرویس‌های غیرحیاتی (Mailhog/داشبورد) را محدود کنید.

## 11. شواهد، Audit و زنجیرهٔ حفاظت

- رویدادهای الزامی در [security.md](../security.md) §9.1؛ Audit فقط Append است و از API قابل Update/Delete نیست.
- برای هر حادثه امنیتی این‌ها را جمع کنید (با ثبت زمان جمع‌آوری):
  - خروجی `/readyz` و `/metrics` در بازهٔ حادثه (بدون توکن/Secret)؛
  - لاگ JSON API با `request_id`های مرتبط و لاگ Proxy/WAF؛
  - رکوردهای Audit مرتبط (`token.refresh.reuse_detected`، `session.revoked`، `key.rotate`، `admin.step_up`)؛
  - Snapshot بکاپ **قبل** از هر تغییر مخرب (اگر ممکن است) و SHA-256 آن؛
  - فهرست اقدام‌ها با زمان UTC و عامل (Agent).
- شواهد را در محل محدود با دسترسی `idp:audit:read` نگه دارید؛ Export خودش Audit می‌شود.
- PII را Mask کنید (ایمیل/موبایل) و در تیکت عمومی نگذارید.

## 12. Rollback و پس از حادثه

- **کد/Image**: به Release قبلی برگردید؛ مهاجرت‌ها را فقط با تأیید و پس از بررسی `down.sql` برگردانید (`pnpm --filter @idpn/api run db:rollback`).
- **کلاینت/Secret**: [app-onboarding.md](./app-onboarding.md) — چرخش Secret و Rollback ایمن.
- **محیط Staging**: [deploy/staging/README.md](../../deploy/staging/README.md).
- **Postmortem** (SEV1/SEV2) حداکثر ۴۸ ساعت بعد: تایم‌لاین، علت ریشه‌ای، چه چیزی خوب کار کرد، اقدام‌های پیشگیرانه با مالک و تاریخ. یک اقدام باید یا تست جدید باشد یا Alert/داشبورد جدید؛ نه فقط «دقت بیشتر».
- چرخش کلید/Secret بعد از هر Suspected Compromise الزامی است، حتی اگر علت اثبات نشود.
