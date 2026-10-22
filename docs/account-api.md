# API حساب کاربری (Embedded)

> سطح حساب کاربری که ماژول `account` در همان Origin سرویس‌دهنده هویت (IdP) مصرف می‌کند.
> ورود همیشه با Redirect به Hosted Auth UI انجام می‌شود؛ این Endpointها فقط پس از ورود
> و با کوکی نشست قابل استفاده‌اند. این سطح از Admin API جدا است و به Scopeهای `idp:*`
> نیاز ندارد.

## 1. احراز هویت

- فقط کوکی `idpn_session` (`HttpOnly; Secure; SameSite=Lax`) پذیرفته می‌شود.
- توکن Bearer، هدر `Authorization` یا `clientId` ورودی مبنای احراز هویت نیست.
- همه پاسخ‌ها `Cache-Control: no-store` دارند.
- برای درخواست‌های تغییردهنده (`PUT`/`DELETE`) شرط‌های CSRF اجباری است:
  - `Origin` باید دقیقاً با Origin همان IdP برابر باشد؛
  - در نبود `Origin`، هدر `Sec-Fetch-Site` باید `same-origin` یا `none` باشد؛
  - `PUT` فقط با `Content-Type: application/json` پذیرفته می‌شود.

## 2. Endpointها

| متد    | مسیر                             | توضیح                                      |
| ------ | -------------------------------- | ------------------------------------------ |
| GET    | `/api/v1/account/profile`        | پروفایل کاربر جاری                         |
| PUT    | `/api/v1/account/password`       | تغییر رمز با رمز فعلی                      |
| GET    | `/api/v1/account/sessions`       | نشست‌های فعال همان کاربر (`page`, `limit`) |
| DELETE | `/api/v1/account/sessions/{sid}` | بستن یک نشست متعلق به همان کاربر           |

### 2.1 پروفایل

```json
{
  "id": "…",
  "username": "sara",
  "email": "sara@example.com",
  "displayName": "Sara",
  "phone": null,
  "avatarUrl": null,
  "locale": "fa-IR",
  "status": "active",
  "emailVerified": true,
  "mustChangePassword": false,
  "createdAt": "2026-10-19T09:00:00.000Z",
  "passwordChangedAt": null
}
```

### 2.2 تغییر رمز

```http
PUT /api/v1/account/password
Content-Type: application/json
Origin: https://auth.example.com
Cookie: idpn_session=…
```

```json
{ "currentPassword": "…", "newPassword": "…" }
```

- رمز فعلی الزامی است؛ سیاست رمز (`docs/auth-flows.md` 8.5) روی سرور اعمال می‌شود.
- در موفقیت، همه نشست‌ها و Refresh Tokenهای **دیگر** باطل می‌شوند و نشست جاری باز می‌ماند.
- Audit با اقدام `user.password.changed` ثبت می‌شود و هرگز رمز یا Hash در آن نیست.

```json
{ "ok": true, "revokedSessions": 2, "revokedRefreshTokens": 3, "keptCurrentSession": true }
```

خطاها به‌صورت RFC 9457 با فیلدهای افزوده `code` و `violations` برگردانده می‌شوند:

| وضعیت | `code`                     | معنا                              |
| ----- | -------------------------- | --------------------------------- |
| 400   | `invalid_current_password` | رمز فعلی نادرست است               |
| 422   | `password_policy`          | نقض سیاست؛ `violations` آرایه است |
| 422   | `password_reuse`           | رمز جدید با رمز فعلی یکسان است    |
| 401   | `login_required`           | نشست معتبر وجود ندارد             |
| 403   | `cross_origin_request`     | درخواست Cross-Origin رد شد        |

### 2.3 نشست‌ها

- فقط نشست‌های فعال همان کاربر بازگردانده می‌شوند؛ `current` نشست جاری را مشخص می‌کند.
- بستن نشست کاربر دیگر دقیقاً مانند نشست ناموجود `404` است.
- بستن نشست جاری از این مسیر `409` با `code: current_session` است؛ خروج از حساب مسیر جداگانه دارد.
- Audit با اقدام `session.revoke` و `metadata.selfService = true` ثبت می‌شود.

## 3. احراز هویت دومرحله‌ای (TOTP)

همه مسیرهای این بخش همان قواعد بخش 1 را دارند (کوکی نشست، `no-store` و شرط CSRF).
روش WebAuthn در فاز بعد اضافه می‌شود؛ در این فاز فقط `type: "totp"` پشتیبانی می‌شود.

| متد  | مسیر                                      | توضیح                                        |
| ---- | ----------------------------------------- | -------------------------------------------- |
| GET  | `/api/v1/account/mfa`                     | وضعیت عامل‌های MFA و تعداد کدهای بازیابی مانده |
| POST | `/api/v1/account/mfa/totp/enroll`          | ساخت عامل TOTP (با رمز فعلی) و بازگرداندن Secret یک‌باره |
| POST | `/api/v1/account/mfa/totp/verify`          | تأیید ثبت با یک کد معتبر و صدور کدهای بازیابی  |
| POST | `/api/v1/account/mfa/totp/disable`         | حذف عامل با رمز فعلی یا یک کد معتبر            |
| POST | `/api/v1/account/mfa/recovery-codes`       | ساخت مجدد کدهای بازیابی با رمز فعلی            |

- هر مسیری که رمز فعلی را بررسی می‌کند (ثبت، حذف، چرخش کدهای بازیابی و تغییر رمز) سهمیهٔ
  مشترک ۱۰ درخواست در دقیقه **به ازای هر حساب** دارد؛ رمز نادرست مانند ورود ناموفق در شمارندهٔ
  قفل ثبت می‌شود و پس از پنج شکست پاسخ `429` با `code: account_locked` است.
- حذف آخرین عامل وقتی سیاست مؤثر اپ `required_admins` یا `required_all` است با `409` و
  `code: mfa_required_method` رد می‌شود تا کاربر از حساب خود قفل نشود
  (`docs/auth-flows.md` 7.5).

### 3.1 ثبت

```json
{ "factorId": "…", "secret": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  "otpauthUri": "otpauth://totp/auth.example.com:sara%40example.com?secret=…",
  "algorithm": "SHA1", "digits": 6, "period": 30 }
```

- بدنه درخواست `{ "password": "…", "name": "…" }` است: **رمز فعلی الزامی است** تا یک نشست
  ربوده‌شده نتواند بدون رمز، یک Authenticator تحت کنترل مهاجم را ثبت کند. رمز نادرست `400` با
  `code: invalid_current_password` برمی‌گرداند و هیچ عاملی ساخته نمی‌شود.
- Secret فقط در همین پاسخ برمی‌گردد و در پایگاه‌داده به‌صورت AES-256-GCM ذخیره می‌شود.
- تأیید ثبت (`verify`) در موفقیت **۱۰** کد بازیابی یک‌بارمصرف برمی‌گرداند؛ فقط Hash آن‌ها ذخیره می‌شود.
- عامل تأییدنشده با درخواست ثبت بعدی جایگزین می‌شود؛ اگر عامل تأییدشده وجود داشته باشد `409` با `code: totp_already_enrolled`.

### 3.2 ورود

- پس از رمز صحیح، اگر عامل تأییدشده وجود داشته باشد نشست صادر نمی‌شود و پاسخ `POST /api/v1/login`
  شامل `{ "ok": false, "mfa": "challenge", "challengeToken": "…", "methods": ["totp","recovery"] }` است.
- تکمیل ورود با `POST /api/v1/login/mfa/verify` و بدنه `{ "challengeToken", "code", "method" }` انجام می‌شود.
- توکن چالش تصادفی، ۵ دقیقه معتبر، به کاربر/کلاینت/`return_to` مقید و یک‌بارمصرف است؛ پس از پنج کد
  نادرست باطل می‌شود (`429` با `code: mfa_rate_limited`).
- هر تلاش **پیش از** بررسی کد به‌صورت اتمیک رزرو می‌شود؛ بنابراین درخواست‌های هم‌زمان نمی‌توانند
  بودجهٔ پنج‌تایی را با هم خرج کنند.
- کد نادرست مانند رمز نادرست در شمارندهٔ قفل حساب ثبت می‌شود؛ پس از پنج شکست، حساب ۱۵ دقیقه قفل
  می‌شود و ورود با رمز هم تا پایان قفل رد می‌شود. هر دو مسیر (TOTP و Passkey) محدودیت نرخ بر اساس
  آدرس کلاینت دارند.
- در موفقیت نشست با `amr` شامل `totp` یا `recovery` و `acr = urn:on4net:acr:mfa` ساخته می‌شود.
- کد TOTP با پنجره ±۱ گام و ضد Replay بر اساس آخرین گام پذیرفته‌شده است؛ کد بازیابی یک‌بارمصرف است.

### 3.3 خطاها

| وضعیت | `code`                       | معنا                                              |
| ----- | ---------------------------- | ------------------------------------------------- |
| 400   | `invalid_mfa_code`           | کد نادرست یا تکراری است                           |
| 400   | `invalid_current_password`   | رمز فعلی نادرست است                               |
| 401   | `mfa_challenge_invalid`      | چالش ناموجود/منقضی/مصرف‌شده است                   |
| 404   | `mfa_factor_not_found`       | عامل MFA وجود ندارد                               |
| 409   | `totp_already_enrolled`      | عامل تأییدشده از قبل وجود دارد                    |
| 429   | `mfa_rate_limited`           | تعداد تلاش‌های نادرست از حد گذشت                   |
| 503   | `mfa_unavailable`            | کلید رمزنگاری Secret روی این استقرار تنظیم نشده است |

Audit: `user.mfa.enrolled`، `user.mfa.removed`، `user.mfa.failed`، `user.mfa.recovery_codes_rotated`،
`user.mfa.recovery_used` و `user.login.mfa_enrollment_required`. هیچ Secret، کد یا Hashی در Audit نیست.

