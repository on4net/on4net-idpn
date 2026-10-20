# مبنای کارایی (Performance Baseline)

> کارت #47. ابزار و سناریوها در [`tools/perf`](../tools/perf/README.md)؛ آستانه‌ها همان اهداف
> [testing.md](./testing.md) بخش ۱۰ و [architecture.md](./architecture.md) بخش SLO هستند.
> اعداد زیر روی یک محیط توسعه محلی اندازه‌گیری شده‌اند، نه ظرفیت تولید.

## ۱. محیط اندازه‌گیری

| مورد | مقدار |
|---|---|
| تاریخ | 2026-10-20 |
| سیستم | Windows 11، AMD Ryzen 9 9950X (16C/32T)، 16GB اختصاص‌یافته به Docker Desktop |
| Node.js | 24.12.0 (tsx) — یک process API |
| PostgreSQL | 16-alpine، کانتینر `idpn-postgres`، `127.0.0.1:55440` |
| Redis | 7-alpine، کانتینر `idpn-redis`، `127.0.0.1:56380` |
| بار | k6 v0.54.0 در کانتینر `grafana/k6:0.54.0` (Docker Desktop) |
| داده | `pnpm perf:seed` — یدک کاربر superadmin، دو کلاینت `perf-admin`/`perf-app`، 250 کاربر فهرست |
| تنظیم API | `SESSION_MAX_CONCURRENT=0`، `KEY_ROTATION_INTERVAL_DAYS=0`، `KEY_CACHE_TTL_SECONDS=30` |
| Warmup | ۵ ثانیه؛ Setup (login + code exchange + توکن مشترک) خارج از پنجره اندازه‌گیری |

دستور اجرا:

```powershell
pnpm perf:load:smoke                         # گیت CI: ۱۵ ثانیه اندازه‌گیری + warmup
node tools/perf/run-load.mjs --profile full --duration 60
```

## ۲. نتیجه Smoke (گیت SLO)

`pnpm perf:load:smoke` — همه آستانه‌ها سبز، `checks=100%`، `http_req_failed=0%`،
`dropped_iterations=0`، مجموع ۶۶۹٫۹ RPS و ۱۴٬۱۳۳ درخواست.

| سناریو | نرخ تنظیم‌شده | نرخ واقعی | p95 | p99 | هدف p95 |
|---|---:|---:|---:|---:|---:|
| discovery | 100/s | 71.1/s | 2.01ms | 3.33ms | < 100ms |
| jwks | 150/s | 106.7/s | 1.83ms | 2.89ms | < 50ms |
| authorize (SSO) | 30/s | 21.4/s | 46.91ms | 58.02ms | < 150ms |
| token_exchange | 5/s | 3.6/s | 166.93ms | 178.02ms | < 300ms |
| token_refresh | 5/s | 3.6/s | 174.02ms | 185.44ms | < 300ms |
| login | 1/s | 0.76/s | 167.05ms | 177.46ms | < 800ms |
| userinfo | 100/s | 71.1/s | 4.91ms | 8.90ms | < 150ms |
| admin_users | 30/s | 21.4/s | 11.24ms | 22.33ms | < 300ms |
| admin_audit | 30/s | 21.4/s | 11.48ms | 22.60ms | < 300ms |
| bundle | 100/s | 71.1/s | 6.89ms | 10.06ms | < 100ms |

> «نرخ واقعی» کمتر از نرخ تنظیم‌شده است چون k6 نرخ `http_reqs` را روی کل اجرا (شامل Setup و
> Warmup) میانگین می‌گیرد. `dropped_iterations=0` نشان می‌دهد نرخ درخواست واقعاً اعمال شده است.
>
> حساسیت محیط: یک اجرای دیگر از همان پروفایل هنگام باقی‌ماندن یک dev server بی‌ربط
> (Playwright webServer) روی همان ماشین، `dropped_iterations=44` و p95 توکن ≈۵۱۵ms داد. پس از
> بستن آن، هر دو اجرا دوباره سبز شدند. برای اندازه‌گیری معتبر، dev serverهای دیگر را ببندید و
> از یک ماشین/CI runner خالی استفاده کنید.

## ۳. نتیجه Full (بررسی ظرفیت، ۶۰ ثانیه)

نرخ‌ها دو برابر Smoke (توکن ۱۰/s برای هر دو گرنت، login ۲/s). این پروفایل **گیت CI نیست** و
برای یافتن نقطه اشباع اجرا می‌شود.

| سناریو | p95 | p99 | هدف p95 | وضعیت |
|---|---:|---:|---:|---|
| discovery | 4.90ms | 8.59ms | 100ms | ✅ |
| jwks | 4.95ms | 8.63ms | 50ms | ✅ |
| authorize (SSO) | 136.12ms | 283.81ms | 150ms | ✅ |
| token_exchange | 363.44ms | 527.12ms | 300ms | ❌ |
| token_refresh | 406.63ms | 614.33ms | 300ms | ❌ |
| login | 376.73ms | 475.77ms | 800ms | ✅ |
| userinfo | 20.09ms | 39.81ms | 150ms | ✅ |
| admin_users | 56.34ms | 115.36ms | 300ms | ✅ |
| admin_audit | 54.62ms | 113.05ms | 300ms | ✅ |
| bundle | 21.79ms | 44.54ms | 100ms | ✅ |

مجموع: ۱٬۰۸۸٫۶ RPS، خطای HTTP صفر، ۶۸ `dropped_iteration` (۰٫۹۹٪ درخواست‌ها) — یعنی
همین کف ظرفیت یک process با این سخت‌افزار و threadpool ۸ است. با threadpool پیش‌فرض (۴)
همین اجرا p95 توکن ۴۰۵–۴۰۶ms و افت مشابه داشت (`UV_THREADPOOL_SIZE=8` فقط حدود ۱۰٪ بهتر شد).

### یافته: هزینه Argon2 در `/token`

هر درخواست `/token` با `client_secret_basic` یک تأیید Argon2id (~۱۲۰–۱۵۰ms در این محیط)
انجام می‌دهد. در بار ترکیبی ۱۰+۱۰ توکن در ثانیه به‌همراه login (۲/s) و Admin API، صف
پردازش از SLO عبور می‌کند. سناریوی مجزا با ۱۰ توکن/s p95 ≈ ۱۴۰ms داشت؛ بنابراین شکست Full
ناشی از **اشباع پردازش رمز کلاینت در یک process** است، نه رگرسیون مسیر توکن.

- رفع کامل نیازمند تصمیم امنیتی است: جایگزینی Argon2id کلاینت با HMAC-SHA256 با pepper
  (سکرت کلاینت آنتروپی بالایی دارد) یا کش کوتاه‌مدت تأیید سکرت. هر دو تغییر قرارداد امنیتی
  دارند و در کارت جداگانه باید بررسی شوند.
- تا آن زمان: Smoke گیت SLO است؛ برای بار بالاتر باید API را افقی مقیاس داد
  (چند instance + Redis/Postgres مشترک) و پیش از انتشار، ظرفیت را روی محیط staging اندازه گرفت.
- هدف سند معماری «۵۰ login/s» در این محیط تک‌process تأیید **نشده** است.

## ۴. اثر کش کلید امضا (JWKS)

`SigningKeyManager` قبلاً برای هر درخواست JWKS/امضا/تأیید، دو بار مخزن کلید را می‌خواند
(فایل JSON در توسعه، KMS/Vault در تولید). اکنون لیست کلیدها و مجموعهٔ تأیید JWK در حافظه
کش می‌شوند (TTL پیش‌فرض ۳۰ ثانیه، `KEY_CACHE_TTL_SECONDS`؛ ابطال فوری روی rotate/revoke).

اندازه‌گیری با `ONLY=jwks RATE_SCALE=10 --duration 20` (۱۵۰۰/s تنظیم‌شده؛ سقف واقعی حدود
۱۰۱۸/s به‌دلیل k6/شبکه):

| حالت | p95 | p99 | نرخ |
|---|---:|---:|---:|
| کش خاموش (`KEY_CACHE_TTL_SECONDS=0`) | 1.18ms | 1.46ms | 1015.9/s |
| کش روشن (۳۰s) | 0.74ms | 0.91ms | 1018.0/s |

p95 حدود ۳۷٪ بهتر شد و تعداد خواندن مخزن کلید از «۲ بار در هر درخواست» به «یک بار در هر
۳۰ ثانیه» کاهش یافت. تست‌های `api/src/oidc/key-lifecycle.test.ts` این رفتار را ثابت می‌کنند
(۲۵ درخواست JWKS + ۲۵ تأیید بدون خواندن مجدد؛ دیدن rotation بین‌process پس از TTL؛ ابطال
فوری روی rotate/revoke).

## ۵. بارگذاری Remote MFE

`remoteEntry.js` ساخته‌شده با `pnpm --filter @idpn/web run build:mfe` روی
`vite preview` (پورت 5174) با `--only mfe_remote --rate-scale 10 --duration 15`:

| شاخص | مقدار |
|---|---|
| نرخ تنظیم‌شده / واقعی | 1000/s / 749.9/s |
| p95 | 2.96ms |
| p99 | 3.91ms |
| خطا | 0٪ (۱۵٬۰۰۱ درخواست) |
| حجم `remoteEntry.js` | 21.25KB (۷٫۱۲KB gzip) |

این سناریو فقط self remoteEntry را می‌سنجد؛ chunkهای ماژول (`user-management` 5.93KB gzip،
`account` 6.91KB gzip) و React مشترک هنگام Mount و به‌صورت Lazy بارگذاری می‌شوند.

**شکاف باقی‌مانده:** حجم اولیه Hosted UI در Build فعلی `551.88KB` (gzip `168.76KB`) است؛
هدف [micro-frontend.md](./micro-frontend.md) بخش ۱۱ «≤ 150KB gzip» است. این ۱۲٪ بیشتر از
هدف است و رفع آن نیازمند Code Splitting مسیرهای Admin/Account است (خارج از دامنه #47).

## ۶. آنچه تأیید شد و آنچه نشد

**تأییدشده**

- Smoke: همه آستانه‌های p95/p99/error/RPS سبز؛ ۰ درخواست ناموفق؛ ۰ dropped iteration.
- JWKS زیر ۵۰ms در هر دو پروفایل (p95 ≈ ۱٫۷–۵ms) و بهبود اندازه‌گیری‌شده پس از کش.
- Admin API list و bundle در محدوده هدف؛ هیچ لیست بی‌سقف یا N+1 در مسیرهای اندازه‌گیری‌شده
  دیده نشد (صفحه‌بندی/سقف Export از قبل اعمال شده بود).
- Remote MFE: p95 ≈ ۳ms و صفر خطا در ۱۰۰۰ درخواست/s؛ `remoteEntry.js` فقط ۷٫۱۲KB gzip است.
- کش کلید با تست واحد و اندازه‌گیری قبل/بعد.

**تأییدنشده / محدودیت‌ها**

- هدف ۵۰ login/s سند معماری روی این محیط تک‌process بررسی نشد.
- p95 توکن ۳۰۰ms در پروفایل Full (۲۰ توکن/s ترکیبی) نقض می‌شود؛ علت و مسیر رفع در بخش ۳.
- حجم اولیه Hosted UI (gzip 168.76KB) از هدف 150KB بیشتر است؛ Code Splitting انجام نشد.
- نتایج تحت Docker Desktop و یک ماشین توسعه است؛ اعداد مطلق برای ظرفیت تولید قابل استناد
  نیستند. مقایسه قبل/بعد JWKS معتبر است چون محیط و بار یکسان بود.
- soak چندساعته و بررسی نشتی حافظه انجام نشد (فقط ۶۰ ثانیه Full). برای Release واقعی باید
  Nightly با `DURATION=1800` روی staging اجرا شود.
