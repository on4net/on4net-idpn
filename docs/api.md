# قرارداد API

> این سند مسیرها، پارامترها و قالب پاسخ‌ها را تعریف می‌کند. پیاده‌سازی باید با OpenAPI 3.1 مستند و تست شود.

## 1. قراردادهای عمومی

| موضوع | قرارداد |
|---|---|
| Base URL | `https://auth.example.com` |
| مسیر OIDC | `/oauth2/*` و کشف در `/.well-known/*` |
| مسیر Admin | `/api/v1/*` |
| نسخه‌بندی | نسخه در مسیر (`/api/v1`)؛ تغییرات ناسازگار با `/v2` |
| فرمت | JSON با `Content-Type: application/json` (به‌جز Endpointهای OAuth فرم‌محور) |
| نام‌گذاری | OAuth: `snake_case`؛ Admin API: `camelCase` |
| تاریخ‌ها | ISO 8601 UTC (`2026-10-18T12:00:00Z`) |
| شناسه‌ها | UUID v7 برای موجودیت‌ها |
| احراز هویت Admin | Bearer Access Token با Scope `idp.admin` (Global) یا `idp.client-admin` (Delegated) |
| CSRF | برای Admin Panel مبتنی بر Cookie، هدر `X-CSRF-Token` الزامی |
| Rate Limit | هدرهای `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` |
| Idempotency | برای `POST`های حساس، هدر اختیاری `Idempotency-Key` |
| زبان خطا | انگلیسی برای کد/پیام فنی؛ متن UI از پنل بومی‌سازی می‌شود |

### 1.1 قالب خطا (RFC 9457)

```json
{
  "type": "https://auth.example.com/problems/validation-error",
  "title": "Validation failed",
  "status": 422,
  "detail": "email must be a valid address",
  "instance": "/api/v1/users",
  "traceId": "6f1c..."
}
```

### 1.2 صفحه‌بندی

```
GET /api/v1/users?page=1&limit=25&sort=createdAt:desc&q=ali
```

```json
{
  "items": [],
  "page": 1,
  "limit": 25,
  "total": 0
}
```

- حداکثر `limit` = 100.
- `q` جست‌وجوی متنی در فیلدهای مجاز.
- مرتب‌سازی فقط روی فیلدهای Allowlist.

---

## 2. Endpointهای OIDC

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/.well-known/openid-configuration` | کشف تنظیمات |
| GET | `/.well-known/jwks.json` | کلیدهای عمومی امضا |
| GET | `/oauth2/authorize` | شروع ورود |
| POST | `/oauth2/token` | تبدیل Code/Refresh به توکن |
| GET | `/oauth2/userinfo` | اطلاعات کاربر |
| POST | `/oauth2/introspect` | بررسی اعتبار توکن (برای سرویس‌ها) |
| POST | `/oauth2/revoke` | ابطال توکن |
| GET/POST | `/oauth2/logout` | خروج سراسری (RP-Initiated) |
| POST | `/oauth2/backchannel-logout` | دریافت Logout Token توسط کلاینت (سمت کلاینت) |
| GET | `/oauth2/social/{clientId}/{provider}/start` | شروع ورود اجتماعی با Credential همان اپ |
| GET | `/oauth2/social/{clientId}/{provider}/callback` | Callback اختصاصی Provider |
| POST | `/oauth2/device_authorization` | اختیاری، فاز بعد |

### 2.1 کشف تنظیمات

```json
{
  "issuer": "https://auth.example.com",
  "authorization_endpoint": "https://auth.example.com/oauth2/authorize",
  "token_endpoint": "https://auth.example.com/oauth2/token",
  "userinfo_endpoint": "https://auth.example.com/oauth2/userinfo",
  "jwks_uri": "https://auth.example.com/.well-known/jwks.json",
  "end_session_endpoint": "https://auth.example.com/oauth2/logout",
  "revocation_endpoint": "https://auth.example.com/oauth2/revoke",
  "introspection_endpoint": "https://auth.example.com/oauth2/introspect",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["ES256"],
  "scopes_supported": ["openid", "profile", "email", "phone", "offline_access", "idp.client-admin"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "none"],
  "code_challenge_methods_supported": ["S256"],
  "claims_supported": [
    "sub", "iss", "aud", "exp", "iat", "auth_time", "nonce",
    "acr", "amr", "sid", "tenant_id", "preferred_username",
    "email", "email_verified", "name"
  ],
  "backchannel_logout_supported": true,
  "backchannel_logout_session_supported": true
}
```

### 2.2 `/oauth2/token`

**درخواست Authorization Code:**

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <base64(client_id:client_secret)>

grant_type=authorization_code
&code=...
&redirect_uri=https%3A%2F%2Fplatform-a.example.com%2Fcallback
&code_verifier=...
```

**درخواست Refresh:**

```
grant_type=refresh_token&refresh_token=...&scope=openid%20profile%20email
```

پارامترها مطابق RFC 6749 به‌صورت `application/x-www-form-urlencoded` ارسال می‌شوند؛ بدنه JSON نیز برای
کلاینت‌های داخلی (first-party) پذیرفته می‌شود.

**پاسخ موفق:** `200`

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 600,
  "refresh_token": "rft_...",
  "scope": "openid profile email offline_access",
  "id_token": "eyJ..."
}
```

**خطاها:** `400` (`invalid_request`, `invalid_grant`, `invalid_scope`, `unsupported_grant_type`)، `401` (`invalid_client`)، `429` (Rate Limit).

### 2.3 `/oauth2/userinfo`

```http
GET /oauth2/userinfo
Authorization: Bearer <access_token>
```

```json
{
  "sub": "e6f0c2a1-...",
  "preferred_username": "ali",
  "name": "Ali Rezaei",
  "email": "ali@example.com",
  "email_verified": true,
  "phone_number": "+98912...",
  "phone_number_verified": true,
  "locale": "fa-IR",
  "tenant_id": "default"
}
```

- فقط Claimهای متناظر با Scopeهای توکن برگردانده می‌شوند.
- خطای `401` برای توکن نامعتبر/منقضی.

### 2.4 `/oauth2/introspect`

```http
POST /oauth2/introspect
Authorization: Basic <client auth>
Content-Type: application/x-www-form-urlencoded

token=...&token_type_hint=refresh_token
```

```json
{
  "active": true,
  "scope": "openid profile",
  "client_id": "platform-a",
  "sub": "e6f0c2a1-...",
  "aud": "platform-a",
  "iss": "https://auth.example.com",
  "exp": 1760000600,
  "iat": 1760000000,
  "sid": "c1a2...",
  "tenant_id": "default"
}
```

- فقط برای کلاینت‌های محرمانه مجاز.
- توکن نامعتبر: `{"active": false}` بدون افشای دلیل.

### 2.5 `/oauth2/revoke`

```
POST /oauth2/revoke
token=...&token_type_hint=refresh_token
```

- پاسخ همیشه `200` است (حتی برای توکن نامعتبر) تا اطلاعاتی افشا نشود.
- فقط صاحب توکن/کلاینت صادرکننده می‌تواند ابطال کند.

### 2.6 `/.well-known/jwks.json`

```json
{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "use": "sig",
      "alg": "ES256",
      "kid": "2026-10-01",
      "x": "...",
      "y": "..."
    }
  ]
}
```

- `Cache-Control: public, max-age=300`.
- کلیدهای `retired` تا زمان انقضای توکن‌های صادرشده در JWKS می‌مانند.

### 2.7 Public Config (بدون احراز هویت)

```
GET /api/v1/clients/{clientId}/public-config
```

```json
{
  "clientId": "app-a",
  "name": "App A",
  "logoUrl": "https://app-a.example.com/logo.svg",
  "locale": "fa-IR",
  "theme": { "primary": "#0f766e", "radius": "8px" },
  "registrationPolicy": "invite_only",
  "mfaPolicy": "required_admins",
  "socialProviders": [
    { "provider": "google", "label": "Google" },
    { "provider": "facebook", "label": "Facebook" }
  ],
  "features": {
    "userManagement": true,
    "selfServiceRegistration": false,
    "mfa": true
  },
  "mfe": {
    "version": "1.4.0",
    "remoteEntry": "https://cdn.example.com/idpn-mfe/1.4.0/remoteEntry.js"
  }
}
```

- فقط داده عمومی؛ هیچ Secret، Redirect URI یا تنظیمات حساس برنمی‌گردد.
- `Cache-Control: public, max-age=60` + `ETag`.
- CORS فقط برای `allowed_origins` همان کلاینت.
- Rate Limit برای جلوگیری از Enumeration.

### 2.8 Endpointهای سوشال

```
GET /oauth2/social/{clientId}/{provider}/start?login_request=<opaque>
GET /oauth2/social/{clientId}/{provider}/callback?code=...&state=...
```

**قواعد:**

- `login_request` یک تراکنش سمت سرور است که پارامترهای اصلی `/authorize` (redirect_uri، scope، state، nonce، PKCE) را نگه می‌دارد و به `client_id` و `provider` مقید است.
- `start` فقط Providerهای فعال همان کلاینت را می‌پذیرد؛ در غیر این صورت `400 social_provider_disabled`.
- `state` و `nonce` سمت سرور تولید و در Callback اعتبارسنجی می‌شوند.
- `client_secret` همان کلاینت برای Exchange استفاده می‌شود و هرگز به مرورگر نمی‌رسد.
- Callback پس از موفقیت نشست IdP را می‌سازد و جریان `/authorize` را ادامه می‌دهد؛ توکن‌ها مستقیماً در پاسخ Callback به مرورگر داده نمی‌شوند.
- خطاها با Redirect امن به `redirect_uri` ثبت‌شده و پارامتر استاندارد `error` برگردانده می‌شوند.

---

## 3. Admin API

Admin API دو سطح دسترسی دارد:

1. **Global Admin:** Scope `idp.admin` و مجوزهای `idp:*`؛ دسترسی به همه کلاینت‌ها. این Scope فقط برای کلاینت پنل ادمین سراسری مجاز است.
2. **Delegated Admin (ادمین اپ):** Scope `idp.client-admin` با `aud` برابر `client_id` همان اپ؛ فقط مجوزهای `idp:client-*` و فقط برای همان اپ.

**قواعد Delegated Admin:**

- کلاینت اپ باید `idp.client-admin` را در Scopeهای مجاز داشته باشد.
- IdP این Scope را فقط زمانی صادر می‌کند که کاربر حداقل یک مجوز `idp:client-*` برای همان اپ داشته باشد؛ در غیر این صورت درخواست رد می‌شود.
- BFF اپ توکن کاربر را به Admin API می‌فرستد؛ Admin API هم `aud` و هم Scope را بررسی می‌کند.

| مجوز | دسترسی |
|---|---|
| `idp:client-member:read` | مشاهده اعضای همان اپ |
| `idp:client-member:invite` | دعوت عضو جدید به همان اپ |
| `idp:client-member:write` | تغییر وضعیت/ویژگی‌های عضو همان اپ |
| `idp:client-role:read` | مشاهده نقش‌های همان اپ |
| `idp:client-role:write` | ایجاد/ویرایش نقش‌های همان اپ |
| `idp:client-role:assign` | تخصیص/حذف نقش‌های همان اپ |
| `idp:social-provider:read` | مشاهده تنظیمات سوشال همان اپ (بدون Secret) |
| `idp:social-provider:write` | تغییر Credential سوشال همان اپ (با Step-up) |
| `idp:client-session:read` | مشاهده نشست‌های اعضای همان اپ |

- `clientId` مسیر باید با `client_id` توکن یکی باشد؛ در غیر این صورت `403`.
- ادمین اپ هرگز نمی‌تواند نقش سراسری، Client Secret، کلید امضا یا داده اپ دیگر را ببیند/تغییر دهد.
- همه اقدامات تغییردهنده Audit می‌شوند.

همه Endpointهای Global Admin نیازمند Access Token با Scope `idp.admin` هستند. عملیات تغییردهنده نیازمند مجوز ریز متناظر (`idp:user:write` و…) و ثبت Audit هستند.

### 3.1 حساب جاری ادمین

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/v1/me` | پروفایل، نقش‌ها و مجوزهای ادمین |
| GET | `/api/v1/me/sessions` | نشست‌های فعال خود |
| DELETE | `/api/v1/me/sessions/{sid}` | بستن نشست خود |

### 3.2 کاربران

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/users` | `idp:user:read` | فهرست + جست‌وجو |
| POST | `/api/v1/users` | `idp:user:write` | ایجاد کاربر |
| GET | `/api/v1/users/{id}` | `idp:user:read` | جزئیات |
| PATCH | `/api/v1/users/{id}` | `idp:user:write` | ویرایش |
| POST | `/api/v1/users/{id}/disable` | `idp:user:write` | غیرفعال‌سازی + ابطال نشست |
| POST | `/api/v1/users/{id}/enable` | `idp:user:write` | فعال‌سازی |
| POST | `/api/v1/users/{id}/unlock` | `idp:user:write` | بازکردن قفل |
| POST | `/api/v1/users/{id}/reset-password` | `idp:user:write` | ارسال لینک بازنشانی |
| POST | `/api/v1/users/{id}/invite` | `idp:user:invite` | دعوت کاربر |
| GET | `/api/v1/users/{id}/sessions` | `idp:session:read` | نشست‌های کاربر |
| DELETE | `/api/v1/users/{id}/sessions` | `idp:session:write` | بستن همه نشست‌ها |
| DELETE | `/api/v1/users/{id}/sessions/{sid}` | `idp:session:write` | بستن یک نشست |
| GET | `/api/v1/users/{id}/roles` | `idp:role:read` | نقش‌های مؤثر |
| GET | `/api/v1/users/{id}/audit` | `idp:audit:read` | رویدادهای کاربر |

**ایجاد کاربر:**

```http
POST /api/v1/users
```

```json
{
  "username": "ali",
  "email": "ali@example.com",
  "displayName": "Ali Rezaei",
  "phone": "+98912...",
  "locale": "fa-IR",
  "sendInvite": true,
  "roleAssignments": [
    {
      "roleKey": "platform-a:member",
      "scopeType": "global",
      "scopeId": null
    }
  ]
}
```

**پاسخ:** `201` با شناسه کاربر؛ رمز عبور موقت فقط در صورت تولید خودکار و **یک بار** برگردانده می‌شود.

### 3.3 کلاینت‌ها

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/clients` | `idp:client:read` | فهرست |
| POST | `/api/v1/clients` | `idp:client:write` | ایجاد |
| GET | `/api/v1/clients/{clientId}` | `idp:client:read` | جزئیات (با `clientId` عمومی) |
| PATCH | `/api/v1/clients/{clientId}` | `idp:client:write` | ویرایش |
| POST | `/api/v1/clients/{clientId}/secrets` | `idp:client:write` | ساخت Secret جدید |
| DELETE | `/api/v1/clients/{clientId}/secrets/{secretId}` | `idp:client:write` | ابطال Secret |
| POST | `/api/v1/clients/{clientId}/disable` | `idp:client:write` | غیرفعال‌سازی + ابطال توکن‌ها |

**ایجاد کلاینت:**

```json
{
  "clientId": "platform-a",
  "name": "پلتفرم A",
  "type": "web",
  "redirectUris": ["https://platform-a.example.com/callback"],
  "postLogoutRedirectUris": ["https://platform-a.example.com/"],
  "scopes": ["openid", "profile", "email", "offline_access", "idp.client-admin"],
  "accessTokenTtl": 600,
  "refreshTokenTtl": 2592000,
  "backchannelLogoutUri": "https://platform-a.example.com/auth/backchannel-logout",
  "registrationPolicy": "invite_only",
  "mfaPolicy": "required_admins",
  "allowedEmailDomains": ["example.com"],
  "branding": {
    "logoUrl": "https://platform-a.example.com/logo.svg",
    "primaryColor": "#0f766e"
  },
  "mfeFeatures": {
    "userManagement": true,
    "selfServiceRegistration": false,
    "mfa": true
  },
  "membershipSchema": {
    "type": "object",
    "properties": {
      "department": { "type": "string" }
    },
    "additionalProperties": false
  },
  "tenantId": "default"
}
```

**پاسخ:** شامل `clientId` و در صورت `type=web`، `clientSecret` **فقط یک بار**.

### 3.3.1 عضویت کاربران در اپ (Client Members)

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/clients/{clientId}/members` | `idp:client-member:read` | فهرست اعضای همان اپ |
| POST | `/api/v1/clients/{clientId}/members/invite` | `idp:client-member:invite` | دعوت/افزودن عضو |
| GET | `/api/v1/clients/{clientId}/members/{userId}` | `idp:client-member:read` | جزئیات عضویت |
| PATCH | `/api/v1/clients/{clientId}/members/{userId}` | `idp:client-member:write` | تغییر وضعیت/ویژگی‌ها |
| DELETE | `/api/v1/clients/{clientId}/members/{userId}` | `idp:client-member:write` | حذف عضویت (نه حذف کاربر) |
| PUT | `/api/v1/clients/{clientId}/members/{userId}/roles` | `idp:client-role:assign` | جایگزینی نقش‌های همان اپ |
| GET | `/api/v1/clients/{clientId}/members/{userId}/sessions` | `idp:client-session:read` | نشست‌های همان اپ |

**دعوت عضو:**

```json
{
  "email": "user@example.com",
  "displayName": "User",
  "roleKeys": ["platform-a:member"],
  "attributes": { "department": "sales" }
}
```

- اگر کاربر وجود داشته باشد، فقط `ClientMembership` ساخته می‌شود.
- اگر وجود نداشته باشد، دعوت ارسال و Membership در وضعیت `invited` ثبت می‌شود.
- `roleKeys` فقط نقش‌هایی با `client_id = clientId` را می‌پذیرد.

**تغییر عضویت:**

```json
{
  "status": "suspended",
  "attributes": { "department": "support" }
}
```

- `suspended` باعث ابطال Refresh Tokenهای همان اپ می‌شود.
- `attributes` مطابق `membershipSchema` اعتبارسنجی می‌شود.

### 3.3.2 Providerهای سوشال هر اپ

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/clients/{clientId}/social-providers` | `idp:social-provider:read` | فهرست (بدون Secret) |
| PUT | `/api/v1/clients/{clientId}/social-providers/{provider}` | `idp:social-provider:write` | ایجاد/به‌روزرسانی Credential |
| DELETE | `/api/v1/clients/{clientId}/social-providers/{provider}` | `idp:social-provider:write` | حذف/غیرفعال‌سازی |

```json
{
  "clientKey": "1234567890-abc.apps.googleusercontent.com",
  "clientSecret": "GOCSPX-...",
  "scopes": ["openid", "email", "profile"],
  "allowedEmailDomains": ["example.com"],
  "enabled": true
}
```

**پاسخ:**

```json
{
  "provider": "google",
  "clientKey": "1234567890-abc.apps.googleusercontent.com",
  "enabled": true,
  "callbackUrl": "https://auth.example.com/oauth2/social/platform-a/google/callback",
  "updatedAt": "2026-10-18T12:00:00Z"
}
```

- `clientSecret` فقط نوشتنی است و هرگز برنمی‌گردد.
- تغییر Credential نیازمند Step-up و ثبت Audit است.
- `callbackUrl` باید دقیقاً در کنسول Google/Facebook ثبت شود.
- ادمین اپ فقط برای `clientId` خودش مجاز است.

### 3.4 نقش‌ها و مجوزها

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/permissions` | `idp:role:read` | فهرست مجوزها |
| POST | `/api/v1/permissions` | `idp:role:write` | ایجاد مجوز |
| DELETE | `/api/v1/permissions/{id}` | `idp:role:write` | حذف مجوز (بدون تخصیص فعال) |
| GET | `/api/v1/roles` | `idp:role:read` | فهرست نقش‌ها |
| POST | `/api/v1/roles` | `idp:role:write` | ایجاد نقش |
| GET | `/api/v1/roles/{id}` | `idp:role:read` | جزئیات + مجوزها |
| PATCH | `/api/v1/roles/{id}` | `idp:role:write` | ویرایش |
| PUT | `/api/v1/roles/{id}/permissions` | `idp:role:write` | جایگزینی مجوزها |
| DELETE | `/api/v1/roles/{id}` | `idp:role:write` | حذف (در صورت نبود تخصیص) |

**ایجاد نقش:**

```json
{
  "key": "platform-a:editor",
  "name": "ویرایشگر پلتفرم A",
  "clientId": "platform-a",
  "permissions": [
    "platform-a:contact:read",
    "platform-a:contact:write"
  ]
}
```

- مجوزهای ارسالی باید متعلق به همان `clientId` یا سراسری باشند؛ ادمین اپ فقط مجوزهای همان اپ را می‌تواند به نقش متصل کند.
- ایجاد مجوز جدید برای یک اپ از طریق همین API و با `clientId` همان اپ انجام می‌شود.
- نقش‌های `idp:*` فقط توسط ادمین سراسری ساخته و تخصیص داده می‌شوند.

### 3.5 تخصیص نقش

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/assignments` | `idp:role:read` | فیلتر بر اساس Subject/Scope |
| POST | `/api/v1/assignments` | `idp:role:write` | تخصیص |
| DELETE | `/api/v1/assignments/{id}` | `idp:role:write` | حذف تخصیص |

```json
{
  "subjectType": "user",
  "subjectId": "e6f0c2a1-...",
  "roleKey": "platform-a:member",
  "scopeType": "global",
  "scopeId": null,
  "expiresAt": null
}
```

- `scopeType=global` یعنی نقش در کل Tenant؛ `scopeType=organization` یعنی فقط اعضای سازمان مشخص (`scopeId`).
- دامنه پلتفرم از خودِ Role می‌آید؛ بنابراین `scopeType=client` وجود ندارد.
- Delegated Admin باید از Endpoint اختصاصی `/clients/{clientId}/members/{userId}/roles` استفاده کند؛ استفاده از این API برای او فقط نقش‌های `client_id` خودش را می‌پذیرد و در غیر این صورت `403` می‌دهد.
- تخصیص `idp:superadmin` نیازمند Step-up (MFA تازه) و دلیل متنی است.

### 3.6 گروه‌ها و سازمان‌ها (اختیاری)

| متد | مسیر | توضیح |
|---|---|---|
| GET/POST | `/api/v1/groups` | فهرست/ایجاد گروه |
| GET/PATCH/DELETE | `/api/v1/groups/{id}` | مدیریت گروه |
| PUT | `/api/v1/groups/{id}/members` | جایگزینی اعضا |
| GET/POST | `/api/v1/organizations` | فهرست/ایجاد سازمان |
| GET/PATCH/DELETE | `/api/v1/organizations/{id}` | مدیریت سازمان |
| PUT | `/api/v1/organizations/{id}/members` | جایگزینی اعضا |

### 3.7 نشست‌ها

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/sessions` | `idp:session:read` | فیلتر کاربر/کلاینت/وضعیت |
| DELETE | `/api/v1/sessions/{sid}` | `idp:session:write` | ابطال |
| POST | `/api/v1/users/{id}/logout-all` | `idp:session:write` | خروج سراسری کاربر |

### 3.8 Audit

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/audit-events` | `idp:audit:read` | فیلتر زمانی/عملیات/کاربر |
| GET | `/api/v1/audit-events/export` | `idp:audit:export` | خروجی CSV/NDJSON |

نمونه فیلتر:

```
GET /api/v1/audit-events?from=2026-10-01T00:00:00Z&to=2026-10-18T23:59:59Z&action=user.login.failed&actorId=...
```

### 3.9 کلیدهای امضا

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/keys` | `idp:key:read` | فهرست کلیدها (بدون کلید خصوصی) |
| POST | `/api/v1/keys/rotate` | `idp:key:write` | چرخش کلید |

### 3.10 تنظیمات

| متد | مسیر | مجوز | توضیح |
|---|---|---|---|
| GET | `/api/v1/settings` | `idp:settings:read` | تنظیمات عمومی |
| PATCH | `/api/v1/settings` | `idp:settings:write` | سیاست رمز، عمر نشست، MFA |

---

## 4. Webhook (فاز 2)

رویدادهای قابل انتشار:

- `user.created`
- `user.disabled`
- `session.revoked`
- `role.assigned`
- `user.login.failed` (تجمیعی)

**قرارداد:**

- `POST` به آدرس ثبت‌شده
- هدر `X-IDPN-Signature: t=<timestamp>,v1=<hmac>`
- امضا با HMAC-SHA256 روی `timestamp.body`
- تلاش مجدد با Exponential Backoff
- تحویل حداقل یک‌بار (At-least-once) + `eventId` برای Idempotency

---

## 5. کدهای وضعیت

| کد | کاربرد |
|---|---|
| `200` | موفق |
| `201` | ایجاد شد |
| `204` | بدون محتوا |
| `400` | درخواست نامعتبر |
| `401` | عدم احراز هویت |
| `403` | عدم مجوز |
| `404` | یافت نشد |
| `409` | تعارض (مثلاً ایمیل تکراری) |
| `422` | خطای اعتبارسنجی |
| `429` | محدودیت نرخ |
| `500` | خطای داخلی |
| `503` | سرویس موقتاً در دسترس نیست |

---

## 6. الزامات مستندسازی

- OpenAPI 3.1 برای Admin API و Endpointهای OIDC.
- مستندات قابل اجرا (Redoc/Scalar) در محیط توسعه.
- نمونه cURL برای هر Endpoint.
- تغییرات قرارداد ابتدا در همین سند و سپس در OpenAPI ثبت شود.
