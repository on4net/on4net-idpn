# راه‌اندازی اپ جدید (App Onboarding)

> این سند قرارداد پیکربندی و ابزارهای آماده‌سازی یک اپ را تعریف می‌کند. مراحل عملیاتی، ثبت Callback در کنسول Providerها، چرخش Secret و Rollback در [runbooks/app-onboarding.md](./runbooks/app-onboarding.md) آمده است.

## 1. هدف

برای هر اپ سه کار تکرارشدنی انجام می‌شود:

1. **Credential سوشال همان اپ** (Google/Facebook) با کلید رمزنگاری موجود در IdP ذخیره و Callback دقیق آن گزارش شود.
2. **کاتالوگ مجوز/نقش اپ** به‌صورت اعلانی (config) تعریف و به‌صورت idempotent اعمال شود.
3. **کاربران فعلی اپ** بدون ساخت رمز محلی، با Invite/Verification به IdP منتقل شوند.

هر سه کار از یک ابزار خط فرمان انجام می‌شود؛ هیچ Secretی در فایل config، خروجی دستور یا فایل State نوشته نمی‌شود.

## 2. سند پیکربندی اپ

نمونه‌ها: [`examples/onboarding/platform-a.json`](../examples/onboarding/platform-a.json) و [`examples/onboarding/platform-b.json`](../examples/onboarding/platform-b.json).

```json
{
  "clientId": "platform-a",
  "name": "Platform A",
  "socialProviders": {
    "google": {
      "enabled": true,
      "scopes": ["openid", "email", "profile"],
      "allowedEmailDomains": ["platform-a.example.com"],
      "clientKeyRef": "IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_KEY",
      "clientSecretRef": "IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_SECRET"
    }
  },
  "permissions": [{ "key": "platform-a:contact:read", "description": "Read contacts of the app" }],
  "roles": [
    {
      "key": "platform-a:member",
      "name": "Member",
      "description": "Default member role",
      "permissions": ["platform-a:contact:read"]
    },
    {
      "key": "platform-a:user-admin",
      "name": "User administrator",
      "description": "Delegated user administration",
      "permissions": ["idp:client-member:read", "idp:client-member:invite"]
    }
  ],
  "defaultRole": "platform-a:member",
  "userAdminRole": "platform-a:user-admin"
}
```

| فیلد              | الزام | توضیح                                                                       |
| ----------------- | ----- | --------------------------------------------------------------------------- |
| `clientId`        | بله   | شناسه عمومی کلاینت؛ باید از قبل در IdP ثبت شده باشد (Admin API)             |
| `name`            | خیر   | فقط برای گزارش                                                              |
| `socialProviders` | خیر   | کلیدهای مجاز: `google`، `facebook`؛ هر Provider ثبت‌شده Credential می‌خواهد |
| `permissions`     | خیر   | مجوزهای اختصاصی اپ با قالب `<clientId>:<resource>:<action>`                 |
| `roles`           | بله   | حداقل یک نقش                                                                |
| `defaultRole`     | بله   | نقشی که هر عضو جدید دریافت می‌کند؛ باید در `roles` تعریف شده باشد           |
| `userAdminRole`   | بله   | نقش ادمین واگذارشده همین اپ؛ باید در `roles` تعریف شده باشد                 |

سند `strict` است: هر فیلد ناشناخته (تایپو) باعث خطا می‌شود. مقدار Credential هرگز داخل سند نمی‌آید؛ فقط **نام** متغیر محیطی (`clientKeyRef` / `clientSecretRef`).

### 2.1 منبع Credential

دو منبع پشتیبانی می‌شود:

1. **متغیر محیطی**: نام پیش‌فرض `IDPN_SOCIAL_<CLIENT_ID>_<PROVIDER>_CLIENT_KEY` و `..._CLIENT_SECRET` (حروف بزرگ، هر کاراکتر غیرحرفی/عددی به `_` تبدیل می‌شود؛ برای `platform-a` + `google`: `IDPN_SOCIAL_PLATFORM_A_GOOGLE_CLIENT_KEY`). با `clientKeyRef` / `clientSecretRef` می‌توان نام دیگری انتخاب کرد.
2. **فایل Secret غیرکامیت‌شده** (`--secrets-file`) با این قالب:

```json
{
  "apps": {
    "platform-a": {
      "google": { "clientKey": "...", "clientSecret": "..." }
    }
  }
}
```

- `*.secrets.json` در `.gitignore` است؛ فقط `*.secrets.example.json` کامیت می‌شود.
- اولویت: فایل Secret بر متغیر محیطی.
- Secret بلافاصله با `crypto/secret-box.ts` (AES-256-GCM) رمز می‌شود؛ خروجی فقط `clientKeyHint` (چهار کاراکتر آخر کلید عمومی) را نشان می‌دهد.
- اگر `SOCIAL_SECRET_KEY` تنظیم نشده باشد یا معتبر نباشد، ابزار **fail closed** می‌کند و هیچ Secretی را ذخیره نمی‌کند.

## 3. ابزار خط فرمان

```powershell
# اعتبارسنجی بدون نوشتن
pnpm --filter @idpn/api run onboard:client -- apply `
  --config examples/onboarding/platform-a.json `
  --secrets-file ./platform-a.secrets.json --dry-run

# اعمال واقعی (Callback دقیق در خروجی گزارش می‌شود)
pnpm --filter @idpn/api run onboard:client -- apply `
  --config examples/onboarding/platform-a.json `
  --secrets-file ./platform-a.secrets.json
```

| پرچم             | توضیح                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| `--config`       | سند پیکربندی (الزامی)                                                          |
| `--secrets-file` | فایل Secret غیرکامیت‌شده                                                       |
| `--issuer`       | پایهٔ ساخت Callback؛ پیش‌فرض `SOCIAL_CALLBACK_BASE_URL` و در نبود آن `APP_URL` |
| `--skip-social`  | فقط نگاشت مجوز/نقش را اعمال کن                                                 |
| `--dry-run`      | هیچ نوشتنی انجام نمی‌دهد و همان برنامه را گزارش می‌کند                         |
| `--confirm`      | لازم فقط وقتی `NODE_ENV=production` است                                        |
| `--summary`      | مسیر فایل گزارش JSON                                                           |
| `--state`        | مسیر فایل State برای Rollback (پیش‌فرض `artifacts/onboarding/<clientId>.json`) |

خروجی JSON شامل `social[]` (provider، action، `callbackUrl`، `enabled`، `clientKeyHint`)، `mapping[]` (key، kind، action) و `problems[]` است. کد خروج `1` در صورت وجود هر مشکل.

Callback از تابع موجود `socialCallbackUrl()` ساخته می‌شود و با مسیر واقعی سرور یکی است:

```
<issuer>/oauth2/social/{clientId}/{provider}/callback
```

اگر `NODE_ENV=production` باشد و این URL `https` نباشد، ابزار خطا می‌دهد.

## 4. نگاشت مجوز و نقش

قواعد اعتبارسنجی (همه پیش از هر نوشتن اجرا می‌شوند):

- کلید مجوز باید سه بخشی و با `clientId` همان اپ شروع شود (`rbac-validation.ts`).
- کلید نقش باید دو بخشی و با `clientId` همان اپ شروع شود.
- یک نقش فقط می‌تواند به مجوزهای **اعلام‌شده در همین سند** یا **فهرست مجاز ادمین واگذارشده** وصل شود. مجوزهای `idp:*` دیگر (مثل `idp:superadmin`) رد می‌شوند.
- `defaultRole` و `userAdminRole` باید در `roles` باشند و متفاوت باشند.
- کلیدهای تکراری رد می‌شوند.

اعمال از طریق همان `AdminRbacRepository` انجام می‌شود (`createPermission`، `createRole`، `updateRole`، `replaceRolePermissions`)، بنابراین نتیجه با پنل ادمین یکسان است:

- اجرای اول: `create`
- اجرای بعدی: `unchanged` (idempotent)
- تغییر سند: `update`
- تعارض مالکیت (کلید متعلق به اپ دیگر): `conflict` + خطا، بدون نوشتن

`--dry-run` همان برنامه را بدون نوشتن گزارش می‌کند؛ می‌توان آن را در CI روی سندهای اپ‌ها اجرا کرد.

## 5. مهاجرت کاربران (Invite/Verification)

ورودی CSV یا JSON با ستون‌های زیر (نام‌های snake_case هم پذیرفته می‌شود):

| ستون          | الزام | توضیح                                                                                                          |
| ------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| `email`       | بله   | شناسه اصلی تطبیق؛ lowercase می‌شود                                                                             |
| `displayName` | خیر   | حداکثر ۱۲۰ کاراکتر                                                                                             |
| `externalId`  | خیر   | کلید تطبیق با سیستم قدیمی؛ در یک فایل یکتا                                                                     |
| `locale`      | خیر   | مثل `fa-IR` یا `en-US`                                                                                         |
| `roleKeys`    | خیر   | نقش‌های اپ پیش‌فرض، جدا با `;` یا `,`                                                                          |
| `memberships` | خیر   | JSON: `[{"clientId":"platform-a","roleKeys":["platform-a:member"]}]` یا `{"platform-a":["platform-a:member"]}` |

نمونه‌ها: [`examples/onboarding/users.csv`](../examples/onboarding/users.csv) و [`examples/onboarding/users.json`](../examples/onboarding/users.json).

```powershell
pnpm --filter @idpn/api run import:users -- import `
  --client platform-a --file examples/onboarding/users.csv `
  --actor admin@example.com --dry-run

pnpm --filter @idpn/api run import:users -- import `
  --client platform-a --file examples/onboarding/users.csv `
  --actor admin@example.com --mail invite --mail-rate 30 `
  --summary artifacts/onboarding/import-platform-a.json
```

### رفتار

- کاربر جدید با `status=pending` و `password_hash = NULL` ساخته می‌شود (هیچ رمزی تولید نمی‌شود).
- Membership از مسیر `AdminMemberRepository.invite` ساخته می‌شود: `invited` + نقش‌های اپ + نقش پیش‌فرض اپ.
- کاربر موجود: فقط Membership ساخته می‌شود (`linked`).
- Membership موجود: `skipped` (idempotent)؛ با `--resend-mail` لینک تازه ارسال می‌شود (لینک قبلی باطل می‌شود).
- ردیف نامعتبر یا نقش نامعتبر: `error` با دلیل؛ بقیهٔ ردیف‌ها ادامه می‌دهند.
- ایمیل تکرارشده یا `externalId` تکراری در یک فایل: ردیف `error` با `duplicate-row`.
- `--mail invite` (پیش‌فرض): کاربر بدون رمز لینک «تعیین رمز» می‌گیرد؛ کاربر دارای رمز فقط اطلاع‌رسانی بدون توکن.
- `--mail verification`: لینک تأیید ایمیل.
- `--mail none`: بدون ایمیل (فقط ساخت داده).
- `--mail-rate`: حداکثر ایمیل در دقیقه (پیش‌فرض ۳۰، صفر = بدون فاصله).
- حالت Reset ارائه نمی‌شود: کاربر مهاجرت‌شده رمز محلی ندارد، پس تنها مسیر فعال‌سازی لینک Invite (تعیین رمز) است. `sendPasswordReset` فقط برای کاربری معنا دارد که از قبل رمز دارد.
- `--actor`: ایمیل اپراتور که در `invited_by` ثبت می‌شود (باید در همان Tenant وجود داشته باشد).

### گزارش

فایل Summary (JSON) شامل `totals` (rows/created/linked/skipped/error/mailSent/mailFailed) و برای هر ردیف `status`، `reason`، `memberships[]` و `mail` است. همین فایل ورودی Rollback است.

## 6. Rollback

```powershell
# بازگردانی نگاشت مجوز/نقش و Credential سوشالِ همان اجرا
pnpm --filter @idpn/api run onboard:client -- rollback `
  --state artifacts/onboarding/platform-a.json --dry-run

# حذف Membershipها و کاربران ساخته‌شده توسط مهاجرت
pnpm --filter @idpn/api run import:users -- rollback `
  --summary artifacts/onboarding/import-platform-a.json --dry-run
```

- Role/مجوز ساخته‌شده و بدون استفاده حذف می‌شود؛ Role دارای Assignment حذف نمی‌شود (`kept` + دلیل).
- Role از قبل موجود به مجموعه مجوز قبلی خود برمی‌گردد (`restored`).
- Provider ساخته‌شده حذف می‌شود. Providerی که قبل از اجرا وجود داشت حذف نمی‌شود، چون Secret قبلی طبق طراحی قابل بازخوانی نیست (`kept` + اقدام دستی: ثبت مجدد Credential یا چرخش).
- کاربری که این اجرا ساخته و **هیچ** رمز/نشست/Refresh Token/MFA/Identity/Membership دیگری ندارد حذف می‌شود؛ در غیر این صورت `kept` با دلیل.
- در `--dry-run` هیچ نوشتنی انجام نمی‌شود.

جزئیات مراحل و ترتیب امن در [runbook](./runbooks/app-onboarding.md) آمده است.

## 7. محیط Staging

- [`deploy/staging/compose.staging.yaml`](../deploy/staging/compose.staging.yaml): PostgreSQL/Redis/Mail سوش جدا با نام پروژه، Volume، پورت و پسورد مستقل.
- [`deploy/staging/.env.staging.example`](../deploy/staging/.env.staging.example): قرارداد متغیرهای استیجینگ شامل کلیدهای مستقل `SESSION_SECRET`، `SOCIAL_SECRET_KEY`، `MFA_SECRET_KEY` و `SIGNING_KEY_REF`.

هیچ توکن، کوکی یا Ciphertextی از Staging در Production معتبر نیست و برعکس.

## 8. پوشش تست

| موضوع                                            | تست                                                          |
| ------------------------------------------------ | ------------------------------------------------------------ |
| اعتبارسنجی سند و قواعد نگاشت                     | `api/src/onboarding/app-config.test.ts`                      |
| منبع Credential، ماسک کردن، Gate تولید           | `api/src/onboarding/social-credentials.test.ts`              |
| CSV/JSON، وضعیت ردیف‌ها، Rate Limit، Rollback    | `api/src/onboarding/user-import.test.ts`                     |
| Idempotency، Dry-run، رمزنگاری، مهاجرت، Rollback | `api/test/onboarding.integration.test.ts` (PostgreSQL واقعی) |

## 9. محدودیت‌ها

- این ابزار کلاینت را **نمی‌سازد**؛ ثبت کلاینت (Redirect URI، Scope، Branding) از Admin API (`POST /api/v1/clients`) انجام می‌شود.
- ثبت Callback در کنسول Google/Facebook و دریافت Credential واقعی اقدام انسانی است.
- `externalId` فعلاً فقط کلید تطبیق و گزارش است؛ ذخیره آن به‌عنوان Identity نیازمند مقدار جدید در `IdentityProvider` و Migration است.
- چرخش `SOCIAL_SECRET_KEY` بدون کلید قبلی ممکن نیست؛ رویه در Runbook آمده است.
