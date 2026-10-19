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
