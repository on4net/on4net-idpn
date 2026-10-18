# راه‌اندازی محیط توسعه

> این سند پیش‌نیازها، ساختار Workspace، متغیرهای محیطی و اسکریپت‌های ریشه را تعریف می‌کند.
> معماری در [architecture.md](./architecture.md) و استراتژی تست در [testing.md](./testing.md) آمده است.

## 1. پیش‌نیازها

| ابزار | نسخه | توضیح |
|---|---|---|
| Node.js | `>= 22.11` (LTS) | در `package.json` با `engines` اعمال می‌شود |
| pnpm | `>= 9` | نسخه پین‌شده: `9.12.0` |
| Git | — | — |
| Docker + Compose | — | برای PostgreSQL، Redis و Mailhog (کارت #9) |

فعال‌سازی pnpm با Corepack:

```powershell
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm --version
```

## 2. ساختار Workspace

```
.
├── api/               # @idpn/api — Auth Server و Admin API (NestJS + Fastify)
├── web/               # @idpn/web — Hosted Auth UI، Admin Panel و MFE
├── packages/
│   └── config/        # @idpn/config — Schema اعتبارسنجی متغیرهای محیطی با Zod
├── docs/
├── pnpm-workspace.yaml
├── tsconfig.base.json # تنظیمات TypeScript مشترک (strict + Path Aliases)
└── eslint.config.mjs  # ESLint Flat Config مشترک
```

پکیج‌ها به‌صورت ESM (`"type": "module"`) نوشته می‌شوند و پکیج‌های داخلی از طریق
`workspace:*` و Alias `@idpn/config` در `tsconfig.base.json` قابل Import هستند.

## 3. نصب

```powershell
git clone <repository-url>
cd on4net-idpn
pnpm install
```

پکیج‌های Workspace به‌صورت Symlink در `node_modules` ریشه لینک می‌شوند؛ نیازی به `npm link` نیست.

## 4. متغیرهای محیطی

```powershell
Copy-Item .env.example .env
```

سپس مقادیر واقعی را در `.env` جایگزین کنید. `.env` در `.gitignore` است و **هرگز Commit نمی‌شود**؛
فقط `.env.example` با مقادیر نمونه در مخزن نگهداری می‌شود.

| متغیر | الزامی | نمونه | توضیح |
|---|---|---|---|
| `NODE_ENV` | خیر | `development` | یکی از `development`، `test`، `production`؛ پیش‌فرض `development` |
| `PORT` | خیر | `3000` | پورت سرور API؛ پیش‌فرض `3000` |
| `APP_URL` | **بله** | `https://auth.example.com` | Issuer و Base URL سامانه |
| `VITE_APP_URL` | **بله** (برای `web`) | `http://localhost:3000` | همان `APP_URL` که در Build فرانت‌اند قابل استفاده است |
| `ADMIN_URL` | خیر | `https://admin.example.com` | آدرس پنل مدیریت |
| `DATABASE_URL` | **بله** | `postgresql://…` | اتصال PostgreSQL (باید `postgres://` یا `postgresql://` باشد) |
| `REDIS_URL` | **بله** | `redis://localhost:6379` | اتصال Redis (باید `redis://` یا `rediss://` باشد) |
| `SESSION_SECRET` | **بله** | — | حداقل ۳۲ کاراکتر؛ امضای کوکی/CSRF |
| `SIGNING_KEY_REF` | خیر | `vault://idpn/signing` | مرجع کلید امضا؛ در توسعه خالی می‌ماند |
| `MFE_PUBLIC_URL` | خیر | `https://cdn.example.com/idpn-mfe` | آدرس پایه Remoteهای MFE |
| `MFE_ALLOWED_ORIGINS` | خیر | `https://app-a.example.com,https://app-b.example.com` | فهرست Originهای مجاز Host (با کاما) |
| `SOCIAL_CALLBACK_BASE_URL` | خیر | `https://auth.example.com` | پایه Callback سوشال |
| `SMTP_URL` | خیر | `smtp://localhost:1025` | ارسال ایمیل (به `smtp://` یا `smtps://` نیاز دارد) |
| `TRUSTED_PROXY_CIDRS` | خیر | `10.0.0.0/8` | CIDRهای پراکسی معتمد (با کاما) |
| `LOG_LEVEL` | خیر | `info` | `fatal`، `error`، `warn`، `info`، `debug`، `trace`، `silent` |

### اعتبارسنجی

Schema در [`@idpn/config`](../packages/config/src/env.ts) با Zod تعریف شده و در سه نقطه استفاده می‌شود:

- `parseServerEnv(source)` — همه متغیرهای سرور؛
- `parsePublicEnv(source)` — زیرمجموعه عمومی مرورگر (`VITE_*`)؛
- `redactConfig(env)` — نسخه امن برای Log (کلیدهای حساس مثل `SESSION_SECRET` ماسک می‌شوند).

`api/src/config/env.ts` تابع `loadApiEnv()` را ارائه می‌دهد که در Bootstrap فراخوانی می‌شود و
`web/src/config/env.ts` تابع `loadWebEnv()` را برای Build مرورگر.

متغیر نامعتبر یا خالی باعث خطای واضح و توقف Startup می‌شود؛ این خطا همه کلیدهای مشکل‌دار را یک‌جا
برمی‌گرداند و **مقدار** متغیرها را نمایش نمی‌دهد:

```
Invalid environment configuration:
  - APP_URL: is required
  - SESSION_SECRET: must be at least 32 characters long
Fix the values in your .env file. See .env.example and docs/setup.md.
```

ساخت یک Secret معتبر:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

## 5. سرویس‌های محلی با Docker Compose

| سرویس | آدرس محلی | کاربرد |
|---|---|---|
| PostgreSQL 16 | `localhost:5432` | پایگاه داده اصلی |
| Redis 7 | `localhost:6379` | نشست، Rate Limit، Cache |
| Mailhog | `localhost:1025` (SMTP) و `localhost:8025` (UI) | ایمیل آزمایشی |

```powershell
docker compose up -d --wait   # شروع و انتظار تا Healthy شدن همه سرویس‌ها
docker compose ps             # وضعیت و Healthcheck
docker compose logs -f postgres
docker compose stop           # توقف بدون حذف داده
docker compose down           # حذف Container و Network (Volumeها می‌مانند)
docker compose down -v        # حذف کامل همراه داده‌ها (تخریبی)
```

- پورت‌های میزبان از `.env` خوانده می‌شوند: `POSTGRES_PORT`، `REDIS_PORT`، `MAILHOG_SMTP_PORT` و
  `MAILHOG_HTTP_PORT` (پیش‌فرض 5432/6379/1025/8025). اگر پورتی روی ماشین اشغال است، مقدار را تغییر دهید و
  `DATABASE_URL` / `REDIS_URL` را هم به‌روز کنید.
- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` باید با `DATABASE_URL` هم‌خوان باشند.
- داده‌ها در Volumeهای `postgres-data` و `redis-data` نگه‌داری می‌شوند و سرویس‌ها روی شبکه `idpn` هستند.
- پورت‌ها فقط روی `127.0.0.1` منتشر می‌شوند تا پایگاه داده روی شبکه محلی افشا نشود.
- Healthcheck: `pg_isready` برای Postgres، `redis-cli ping` برای Redis و درخواست HTTP به
  `:8025/api/v2/messages` برای Mailhog.
- Mailhog در پروژه اصلی آرشیو شده و نگه‌داری نمی‌شود؛ فقط برای ایمیل آزمایشی محلی استفاده می‌شود و در
  بازبینی Supply Chain (کارت #57) ارزیابی خواهد شد.

## 6. پایگاه داده و Migration

مدل داده با **Prisma 7** و PostgreSQL 16 پیاده‌سازی شده است.

| مورد | مسیر |
|---|---|
| Schema | `api/prisma/schema.prisma` |
| Migrationها | `api/prisma/migrations/<name>/migration.sql` و `down.sql` |
| Seed | `api/prisma/seed.ts` |
| Client تولیدشده | `api/src/generated/prisma` (در Git نیست؛ با `pnpm install` تولید می‌شود) |
| تنظیم اتصال | `api/prisma.config.ts` (از `DATABASE_URL` در `.env` ریشه استفاده می‌کند) |

```powershell
pnpm --filter @idpn/api db:generate   # تولید Client
pnpm --filter @idpn/api db:deploy     # اعمال Migrationها (محیط توسعه و CI)
pnpm --filter @idpn/api db:migrate -- --name add_x   # ساخت Migration جدید
pnpm --filter @idpn/api db:rollback   # برگشت آخرین Migration
pnpm --filter @idpn/api db:seed       # داده اولیه (Idempotent)
```

- **Migration جدید:** Schema را تغییر دهید و `db:migrate -- --name <name>` را اجرا کنید. SQL تولیدشده را بازبینی کنید؛
  اگر تغییر نیاز به SQL دستی دارد (مثل محدودیت `CHECK` یا ایندکس Partial)، آن را به انتهای همان فایل اضافه کنید.
- **Rollback:** برای هر Migration یک `down.sql` نگه‌داری می‌شود. `db:rollback` آخرین Migration اعمال‌شده را در یک
  تراکنش برمی‌گرداند و رکورد آن را از `_prisma_migrations` حذف می‌کند. اگر `down.sql` موجود نباشد، فرمان با خطا متوقف می‌شود.
- **Seed Idempotent:** Tenant پیش‌فرض (`default`)، کلاینت `admin-panel` (با MFA اجباری)، ۱۳ مجوز و ۳ نقش سراسری
  (`idp:superadmin`، `idp:security-admin`، `idp:support`) و کاربران تست `admin`، `support` و `user`.
  کاربران تست عمداً **رمز عبور ندارند**؛ Credential در فاز ۱ (کارت #12) اضافه می‌شود.
- **قواعد سطح دیتابیس:** یکتایی `(tenant_id, email)` و `(tenant_id, username)`، اجباری‌بودن حروف کوچک ایمیل/نام کاربری،
  یکتایی عضویت `(client_id, login_context_id, user_id)` با `NULLS NOT DISTINCT`، یک Context پیش‌فرض برای هر کلاینت،
  سازگاری `scope_type`/`scope_id` در `Assignments` و `ON DELETE RESTRICT` روی FKها.
- **تست:** `pnpm --filter @idpn/api test` با Testcontainers روی PostgreSQL واقعی اجرا می‌شود و Migration، Rollback،
  اعمال مجدد و Idempotency مربوط به Seed را بررسی می‌کند (Docker باید فعال باشد).

## 7. اسکریپت‌ها

| دستور | کار |
|---|---|
| `pnpm lint` | ESLint (Flat Config) روی کل مخزن |
| `pnpm lint:fix` | رفع خودکار خطاهای Lint |
| `pnpm typecheck` | `tsc --noEmit` در تمام پکیج‌های Workspace |
| `pnpm test` | Vitest در تمام پکیج‌های Workspace |
| `pnpm format` / `pnpm format:check` | قالب‌بندی یا بررسی قالب با Prettier |
| `pnpm build` | Build پکیج‌هایی که اسکریپت `build` دارند |

اجرای اسکریپت در یک پکیج مشخص:

```powershell
pnpm --filter @idpn/config test
pnpm --filter @idpn/api typecheck
```

## 8. گام‌های بعدی

- CI و Test Harness — کارت #11
