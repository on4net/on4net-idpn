# Runbook — آماده‌سازی اپ (Onboarding، Mapping، Migration، Rollback)

> مخاطب: اپراتور IdP (دسترسی به دیتابیس/سرور و کنسول Google/Facebook). مرجع پیکربندی: [app-onboarding.md](../app-onboarding.md). قرارداد API: [api.md](../api.md). مدل داده: [domain-model.md](../domain-model.md).

## 0. چه چیزی خودکار است و چه چیزی انسانی

| مرحله                                | ابزار / مسئول                                             |
| ------------------------------------ | --------------------------------------------------------- |
| ثبت کلاینت و Redirect URI            | Admin API (`POST /api/v1/clients`) — تیم IdP              |
| ساخت OAuth App در Google/Facebook    | **انسانی** — صاحب کنسول Provider                          |
| ثبت Callback دقیق در کنسول           | **انسانی** — همان مقدار `callbackUrl` که ابزار چاپ می‌کند |
| ذخیره Credential در IdP              | `onboard-client.ts apply`                                 |
| نگاشت مجوز/نقش                       | `onboard-client.ts apply` (همان سند)                      |
| مهاجرت کاربران (Invite/Verification) | `import-users.ts import`                                  |
| Staging مشترک                        | `deploy/staging/compose.staging.yaml` + Pipeline          |
| Rollback                             | `onboard-client.ts rollback` / `import-users.ts rollback` |

## 1. پیش‌نیازها

- کلاینت در IdP ثبت شده و `redirectUris` آن دقیق است (بدون Wildcard).
- `APP_URL`/`ISSUER` محیط مشخص است (مثلاً `https://auth.staging.example.com`).
- اگر Callback روی دامنهٔ جداگانه‌ای ثبت می‌شود، `SOCIAL_CALLBACK_BASE_URL` همان محیط تنظیم شود؛ ابزار همان مقدار را برای ساخت Callback استفاده می‌کند.
- `SOCIAL_SECRET_KEY` (base64 دقیقاً ۳۲ بایت) در Secret Store همان محیط موجود است.
- دسترسی به کنسول Google Cloud / Meta for Developers برای همان اپ.
- CSV/JSON کاربران از سیستم قدیمی (بدون ستون رمز عبور).

بررسی سریع محیط:

```powershell
node -e "console.log(process.version)"
docker compose --env-file deploy/staging/.env.staging config --quiet
pnpm --filter @idpn/api run typecheck
```

## 2. ثبت Callback در کنسول Provider

Callback همیشه از این قالب ساخته می‌شود و باید **بایت‌به‌بایت** در کنسول ثبت شود:

```
https://<host>/oauth2/social/<clientId>/<provider>/callback
```

مثال برای `platform-a` و `google`:

```
https://auth.staging.example.com/oauth2/social/platform-a/google/callback
```

این مقدار را با `--dry-run` هم می‌توان دید و هم در خروجی `apply` آمده است.

### 2.1 Google Cloud Console

1. APIs & Services → Credentials → **Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorized redirect URIs: همان Callback بالا (برای هر محیط مقدار جدا).
4. Scopes: `openid`, `email`, `profile`.
5. Client ID و Client secret را در Secret Store همان محیط ذخیره کنید (نه در کد/مخزن).
6. اگر صفحه Consent در حالت Testing است، حساب‌های تست را اضافه کنید.

### 2.2 Meta for Developers (Facebook)

1. Create App → **Consumer**.
2. Add product **Facebook Login → Settings**.
3. **Valid OAuth Redirect URIs**: همان Callback بالا.
4. Client Token/App Secret را فقط در Secret Store ذخیره کنید.
5. برای Staging دامنه باید عمومی و HTTPS باشد؛ `localhost` برای تست محدود است.

> تا زمانی که این مرحله انجام نشده، ورود سوشال همان اپ با خطای `redirect_uri_mismatch` شکست می‌خورد. این تنها اقدام باقی‌مانده‌ای است که ابزار نمی‌تواند انجام دهد.

## 3. ثبت/به‌روزرسانی Credential در IdP

1. مقادیر را در منبع غیرکامیت‌شده بگذارید:

```powershell
# گزینه A: متغیر محیطی (پیشنهاد برای CI/Secret Store)
$env:IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_KEY = '<client id>'
$env:IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_SECRET = '<client secret>'

# گزینه B: فایل Secret (git-ignored)
Copy-Item examples/onboarding/secrets.example.json ./platform-a.secrets.json
# مقادیر واقعی را جای‌گذاری کنید
```

2. اعتبارسنجی بدون نوشتن:

```powershell
pnpm --filter @idpn/api run onboard:client -- apply `
  --config examples/onboarding/platform-a.json `
  --secrets-file ./platform-a.secrets.json --dry-run
```

3. اعمال:

```powershell
pnpm --filter @idpn/api run onboard:client -- apply `
  --config examples/onboarding/platform-a.json `
  --secrets-file ./platform-a.secrets.json
```

4. خروجی را ثبت کنید: `callbackUrl` هر Provider (برای مرحله ۲)، `action` (`create`/`update`) و `clientKeyHint`.

نکات امنیتی:

- `NODE_ENV=production` بدون `--confirm` اجرا نمی‌شود.
- Secret هرگز در خروجی/لاگ/State نوشته نمی‌شود؛ فقط چهار کاراکتر آخر Client ID.
- تغییر Credential در Admin API نیازمند Step-up است؛ این ابزار فقط برای اپراتور با دسترسی دیتابیس است. ادمین اپ باید از API استفاده کند.

## 4. نگاشت مجوز/نقش

- مجوزها: `<clientId>:<resource>:<action>`
- نقش‌ها: `<clientId>:<role>`
- نقش فقط مجوزهای اعلام‌شدهٔ همان اپ یا فهرست مجاز ادمین واگذارشده را می‌تواند داشته باشد.
- `defaultRole` روی هر Membership جدید اعمال می‌شود؛ `userAdminRole` نقش ادمین همان اپ است.

```powershell
# Dry-run قبل از تغییر کاتالوگ تولید
pnpm --filter @idpn/api run onboard:client -- apply --config ./platform-a.json --skip-social --dry-run
```

اجرای دوباره هیچ تغییری ایجاد نمی‌کند (`unchanged`). اگر نقش در پنل ادمین دستی تغییر کرده باشد، اجرای بعدی آن را به سند برمی‌گرداند؛ پس سند باید مرجع باشد.

## 5. مهاجرت کاربران فعلی

### 5.1 آماده‌سازی فایل

- خروجی سیستم قدیمی را به CSV/JSON با ستون‌های `email`، `displayName`، `externalId`، `locale`، `roleKeys`/`memberships` تبدیل کنید.
- ستون رمز عبور (حتی هش) را **حذف** کنید؛ ابزار آن را نمی‌خواند.
- ردیف‌های تکراری و ایمیل نامعتبر را از قبل پاک کنید (یا به‌عنوان `error` بپذیرید).

### 5.2 اجرای آزمایشی

```powershell
pnpm --filter @idpn/api run import:users -- import `
  --client platform-a --file ./users.csv --actor admin@example.com --dry-run
```

خروجی `totals` و وضعیت هر ردیف (`created`/`linked`/`skipped`/`error`) را بررسی کنید. در Dry-run هیچ نوشتنی و هیچ ایمیلی انجام نمی‌شود.

### 5.3 اجرای واقعی

```powershell
pnpm --filter @idpn/api run import:users -- import `
  --client platform-a --file ./users.csv --actor admin@example.com `
  --mail invite --mail-rate 30 `
  --summary artifacts/onboarding/import-platform-a.json
```

- `--mail invite`: کاربر بدون رمز، لینک «تعیین رمز» می‌گیرد (۷۲ ساعت، یک‌بارمصرف). کاربر دارای رمز فقط اطلاع‌رسانی بدون توکن.
- `--mail verification`: لینک تأیید ایمیل.
- `--mail-rate`: فاصله بین ارسال‌ها؛ برای SMTP اشتراکی مقدار را پایین نگه دارید.
- اگر SMTP قطع شد، اجرا را با `--resend-mail` تکرار کنید؛ بقیهٔ ردیف‌ها `skipped` می‌شوند و هیچ دادهٔ تکراری ساخته نمی‌شود.
- فقط ردیف‌های `error` را اصلاح و مجدداً همان فایل را اجرا کنید (idempotent و resumable).

### 5.4 بررسی

```sql
-- کاربران ساخته‌شده هرگز رمز محلی ندارند
SELECT count(*) FROM users
WHERE email IN ('ali.rezaei@example.com') AND password_hash IS NOT NULL; -- باید 0 باشد

-- Membership و نقش پیش‌فرض
SELECT cm.status, r.key
FROM client_memberships cm
JOIN clients c ON c.id = cm.client_id
JOIN assignments a ON a.subject_id = cm.user_id AND a.subject_type = 'user'
JOIN roles r ON r.id = a.role_id
WHERE c.client_id = 'platform-a' AND cm.login_context_id IS NULL
ORDER BY cm.created_at DESC LIMIT 20;
```

سپس یک کاربر واقعی باید لینک دعوت را باز کند، رمز تعیین کند و وارد شود. ورود سوشال همان اپ باید با Credential همان اپ انجام شود (نه Credential اپ دیگر).

## 6. محیط Staging مشترک

```powershell
Copy-Item deploy/staging/.env.staging.example deploy/staging/.env.staging
# مقادیر واقعی (پسوردها، کلیدها، دامنه) را جای‌گذاری کنید — فایل git-ignored است
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/compose.staging.yaml up -d
docker compose --env-file deploy/staging/.env.staging `
  -f deploy/staging/compose.staging.yaml ps
```

جداسازی از Production:

| مورد                                   | Staging                                  | Production      |
| -------------------------------------- | ---------------------------------------- | --------------- |
| نام پروژه                              | `idpn-staging`                           | پروژهٔ جدا      |
| Volumeها                               | `idpn-staging-postgres-data` و Redis جدا | Volumeهای خودش  |
| دیتابیس/Redis                          | کاربر، پسورد و پورت جدا                  | جدا             |
| ایمیل                                  | Mailpit (sink) یا Relay مخصوص Staging    | SMTP رسمی       |
| `SESSION_SECRET`                       | مستقل                                    | مستقل           |
| `SOCIAL_SECRET_KEY` / `MFA_SECRET_KEY` | مستقل                                    | مستقل           |
| `SIGNING_KEY_REF`                      | کلید امضای مستقل                         | کلید تولید      |
| Credential سوشال                       | OAuth App همان محیط                      | OAuth App تولید |

پورت‌های Staging روی `127.0.0.1` منتشر می‌شوند؛ برای دسترسی تیمی از Bastion/VPN استفاده کنید. Mailpit در `http://127.0.0.1:8126` قابل مشاهده است.

## 7. چرخش Secret

### 7.1 چرخش Credential Provider (Google/Facebook)

1. در کنسول Provider، Secret جدید بسازید (Client ID ثابت می‌ماند).
2. مقدار جدید را در Secret Store همان محیط به‌روزرسانی کنید.
3. `onboard-client.ts apply` را ابتدا با `--dry-run` و سپس واقعی اجرا کنید (`action: update`).
4. ورود سوشال یک اپ را آزمایش کنید.
5. Secret قدیمی را در کنسول Provider غیرفعال کنید.
6. Secret قدیمی را از Secret Store حذف کنید.

Rollback این مرحله خودکار نیست (Ciphertext قبلی قابل بازخوانی نیست)؛ برای بازگشت باید Credential قدیمی را دوباره ثبت کنید.

### 7.2 چرخش `SOCIAL_SECRET_KEY`

Envelope فعلی یک کلید دارد و شناسهٔ کلید در متن رمزشده نیست؛ بنابراین:

1. کلید جدید را بسازید: `openssl rand -base64 32`.
2. کلید جدید را در Secret Store به‌عنوان مقدار فعال بگذارید.
3. برای **همهٔ** اپ‌ها `onboard-client.ts apply` را با Credential موجود اجرا کنید تا Ciphertext با کلید جدید ساخته شود.
4. ورود سوشال همهٔ اپ‌ها را بررسی کنید (Google و Facebook).
5. کلید قبلی را حذف کنید.

اگر هر اپ جا افتاد، ورود سوشال آن با خطای رمزگشایی شکست می‌خورد؛ در آن حالت Credential آن اپ را دوباره ثبت کنید.

## 8. Rollback

### 8.1 مسیر تست‌شده (ابزار)

```powershell
# 1) مشاهدهٔ برنامهٔ بازگشت
pnpm --filter @idpn/api run onboard:client -- rollback `
  --state artifacts/onboarding/platform-a.json --dry-run

# 2) اجرا
pnpm --filter @idpn/api run onboard:client -- rollback `
  --state artifacts/onboarding/platform-a.json

# 3) کاربران مهاجرت‌شده
pnpm --filter @idpn/api run import:users -- rollback `
  --summary artifacts/onboarding/import-platform-a.json --dry-run

pnpm --filter @idpn/api run import:users -- rollback `
  --summary artifacts/onboarding/import-platform-a.json
```

- `deleted`: Role/مجوز/Provider/Membership/کاربر حذف شد.
- `restored`: Role از قبل موجود بود و مجموعه مجوز قبلی‌اش برگشت.
- `kept`: حذف امن نبود (Assignment دارد، رمز/نشست/MFA دارد، یا Credential قبلی قابل بازگردانی نیست) — دلیل در گزارش آمده است.
- کاربری که این اجرا ساخته و رمز/نشست/Identity دیگری ندارد حذف می‌شود؛ در غیر این صورت دستی بررسی کنید.
- `--keep-users` فقط Membershipها را برمی‌گرداند و کاربران را نگه می‌دارد.

### 8.2 مسیر دستی (اگر فایل State/Summary از دست رفت)

API ادمین:

```http
DELETE /api/v1/clients/platform-a/social-providers/google
Authorization: Bearer <admin access token>
```

```http
PUT /api/v1/roles/{roleId}/permissions
{ "permissions": [] }
```

SQL (فقط برای غیرفعال‌سازی، سپس حذف در پنجرهٔ نگهداشت):

```sql
-- 1) Provider را غیرفعال کنید (حذف فوری ممکن است ورود کاربران را قطع کند)
UPDATE client_social_providers sp
SET enabled = false, updated_at = now()
FROM clients c
WHERE sp.client_id = c.id AND c.client_id = 'platform-a' AND sp.provider = 'google';

-- 2) عضوهای واردشده توسط مهاجرت را پیدا کنید (بر اساس تاریخ اجرا و invite)
SELECT cm.id, u.email, cm.status, cm.invited_at
FROM client_memberships cm
JOIN clients c ON c.id = cm.client_id
JOIN users u ON u.id = cm.user_id
WHERE c.client_id = 'platform-a'
  AND cm.login_context_id IS NULL
  AND cm.invited_at >= timestamptz '2026-10-19 00:00:00+00'
ORDER BY cm.invited_at DESC;

-- 3) کاربر بدون رمز و بدون نشست را حذف کنید (همیشه ابتدا SELECT کنید)
SELECT u.id, u.email
FROM users u
LEFT JOIN sessions s ON s.user_id = u.id
LEFT JOIN identities i ON i.user_id = u.id
WHERE u.email = 'imported@example.com'
  AND u.password_hash IS NULL
  AND s.id IS NULL
  AND i.id IS NULL;
```

برای حذف رکوردها ابتدا Membership و Assignment و AccountToken را پاک کنید (FK)، سپس کاربر را:

```sql
BEGIN;
DELETE FROM account_tokens WHERE user_id = '<user-id>';
DELETE FROM assignments WHERE subject_type = 'user' AND subject_id = '<user-id>';
DELETE FROM client_memberships WHERE user_id = '<user-id>';
DELETE FROM users WHERE id = '<user-id>' AND password_hash IS NULL;
COMMIT;
```

Migration دیتابیس (فقط اگر تغییر اسکیمای این کارت هم منتشر شده باشد):

```powershell
pnpm --filter @idpn/api run db:rollback
```

## 9. چک‌لیست تأیید

- [ ] `onboard-client apply --dry-run` بدون `problems`.
- [ ] `callbackUrl` در کنسول Google/Facebook برای همان اپ/محیط ثبت شد.
- [ ] `apply` واقعی انجام شد و `action` مورد انتظار بود.
- [ ] `GET /api/v1/clients/{clientId}/social-providers` همان Provider را با `enabled=true` نشان می‌دهد.
- [ ] ورود سوشال اپ A با Credential اپ A کار می‌کند و Callback با `clientId`/`state` نادرست رد می‌شود.
- [ ] کاتالوگ مجوز/نقش با `docs` هم‌خوان است و اجرای دوباره `unchanged` است.
- [ ] هیچ کاربر مهاجرت‌شده‌ای `password_hash` ندارد.
- [ ] Invite/Verification واقعاً رسیده و لینک آن کار می‌کند.
- [ ] Rollback روی Staging یک‌بار تمرین و نتیجه‌اش ثبت شده است.
- [ ] Staging از Production جدا است (نام پروژه، DB/Redis، Mail، کلیدها، Credential).

## 10. عیب‌یابی

| نشانه                                            | علت محتمل                                 | اقدام                                             |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------------------------- |
| `redirect_uri_mismatch`                          | Callback در کنسول با مقدار ابزار یکی نیست | مقدار دقیق `callbackUrl` را دوباره ثبت کنید       |
| `SOCIAL_SECRET_KEY is not configured`            | کلید تنظیم نشده/نامعتبر است               | `openssl rand -base64 32` و تنظیم در Secret Store |
| `secret envelope could not be decrypted`         | کلید عوض شده و Ciphertext قدیمی است       | Credential آن اپ را دوباره ثبت کنید               |
| `permission ... must start with "<clientId>"`    | کلید مجوز/نقش متعلق به اپ دیگر است        | سند را اصلاح کنید                                 |
| `role ... links permission ... not in allowlist` | تلاش برای دادن مجوز `idp:*` غیرمجاز       | فقط مجوز اپ یا فهرست ادمین واگذارشده              |
| ردیف `duplicate-row`                             | ایمیل یا `externalId` تکراری در فایل      | فایل را ادغام کنید                                |
| `mail-send-failed`                               | SMTP قطع/محدود                            | `--resend-mail` با نرخ کمتر                       |
| `kept` در Rollback                               | Assignment/رمز/نشست/Identity وجود دارد    | دلیل گزارش را بررسی و دستی تصمیم بگیرید           |
