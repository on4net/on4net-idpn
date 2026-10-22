# امنیت

> این سند مدل تهدید، کنترل‌های الزامی و چک‌لیست پذیرش امنیتی را تعریف می‌کند. مبنای مرجع: OWASP ASVS Level 2، OWASP Top 10، و بهترین‌عمل‌های OAuth 2.1 / OIDC.

## 1. دارایی‌های حیاتی

| دارایی | اثر نقض |
|---|---|
| رمز عبور و Hash آن | تصاحب حساب |
| کلید خصوصی امضای توکن | جعل هویت در همه پلتفرم‌ها |
| Refresh Token | دسترسی بلندمدت |
| Session Cookie | دسترسی به حساب کاربر |
| Client Secret | جعل کلاینت و دریافت توکن |
| Social Provider Secret (per client) | جعل اپ سوشال و ورود با هویت جعلی |
| MFE Remote / CDN Asset | اجرای کد مخرب در مرورگر کاربران |
| ClientMembership و Attributes | افشای داده یا دسترسی Cross-Client |
| داده هویت (ایمیل، موبایل) | حریم خصوصی |
| Audit Log | از دست رفتن قابلیت تشخیص و پاسخ |
| نقش‌ها و تخصیص‌ها | افزایش سطح دسترسی |

## 2. مدل تهدید

| # | تهدید | مسیر حمله | کنترل |
|---|---|---|---|
| T1 | Credential Stuffing | رمزهای افشاشده از سایت‌های دیگر | Rate Limit، قفل تدریجی، MFA، بررسی رمز افشاشده، هشدار |
| T2 | Brute Force | حدس رمز/OTP | محدودیت بر اساس حساب و IP، Backoff نمایی، CAPTCHA اختیاری |
| T3 | Phishing | صفحه ورود جعلی | WebAuthn، آموزش، دامنه ثابت، CSP، HSTS |
| T4 | Code Interception | رهگیری Authorization Code | PKCE اجباری، Redirect URI دقیق، Code یک‌بارمصرف 60 ثانیه |
| T5 | CSRF ورود | اجبار به ورود با حساب مهاجم | `state`، SameSite، تأیید Origin |
| T6 | Open Redirect | دستکاری `redirect_uri` | Exact Match، ممنوعیت Wildcard، بررسی Scheme و Host |
| T7 | Token Theft | XSS یا بدافزار | BFF، عدم ذخیره در localStorage، عمر کوتاه، DPoP در آینده |
| T8 | Refresh Token Reuse | استفاده از توکن دزدیده‌شده | چرخش، تشخیص Reuse، ابطال خانواده، هشدار |
| T9 | JWT Forgery | الگوریتم `none` یا کلید ضعیف | Allowlist الگوریتم، ES256، بررسی `kid`، عدم پذیرش `HS256` از کلاینت |
| T10 | Key Compromise | نشت کلید خصوصی | KMS/Vault، چرخش 90 روزه، حداقل دسترسی، Audit |
| T11 | Session Fixation | تحمیل Session ID | صدور Session جدید در ورود، کوکی امن |
| T12 | Privilege Escalation | دستکاری Claim یا API | بررسی سروری، Deny-by-default، عدم اعتماد به UI، Audit تغییر نقش |
| T13 | Account Enumeration | تفاوت پاسخ ایمیل موجود/ناموجود | پاسخ یکسان، تأخیر یکسان، پیام عمومی |
| T14 | Account Takeover via Reset | سوءاستفاده از لینک بازیابی | توکن Hash‌شده، یک‌بارمصرف، 30 دقیقه، ابطال نشست‌ها، اطلاع‌رسانی |
| T15 | XSS در پنل ادمین | ورودی مخرب در پروفایل | React escaping، CSP سخت‌گیرانه، Sanitize، Cookie HttpOnly |
| T16 | Clickjacking | IFrame پنهان | `frame-ancestors 'none'` (به‌جز صفحات Logout کنترل‌شده) |
| T17 | SSRF | آدرس‌های ثبت‌شده کلاینت | Allowlist دامنه، ممنوعیت IP خصوصی، بررسی در زمان ثبت و ارسال |
| T18 | Supply Chain | وابستگی مخرب | Lockfile، `npm audit`، SBOM، Pin نسخه، بررسی مجوز |
| T19 | Insider Threat | دسترسی ادمین | حداقل دسترسی، MFA، Audit غیرقابل‌تغییر، تفکیک وظایف |
| T20 | DoS | Flood روی `/authorize` و `/token` | Rate Limit لایه‌ای، WAF، صف، Circuit Breaker |
| T21 | PII Leak | لاگ یا خطا | Redaction، حداقل‌سازی داده، رمزنگاری در حالت سکون |
| T22 | Replay Logout Token | ارسال مجدد Logout Token | بررسی `jti`،`iat` کوتاه، امضا |
| T23 | Social Account Takeover | ایمیل تأییدنشده یا Provider جعلی | فقط اتصال با ایمیل Verified، بررسی امضا/`aud`/`iss`/`nonce` |
| T24 | Provider Mix-up | استفاده از Credential اپ دیگر | Callback و تراکنش مقید به `clientId` + `provider`، Secret جداگانه |
| T25 | Social Secret Leak | نشت Secret در UI/لاگ/API | رمزنگاری AES-256-GCM، فقط نوشتنی، Redaction |
| T26 | MFE Supply Chain | Remote آلوده در CDN | Origin Allowlist، نسخه Immutable، CSP، امضای انتشار، بازبینی |
| T27 | MFE Token Exposure | دسترسی Host به توکن | BFF-first، عدم ارسال توکن در رویدادها، SPA فقط برای اپ معتمد |
| T28 | Cross-Client Admin Access | دستکاری `clientId` در API | اعمال سروری `client_id` توکن، Deny-by-default، تست منفی |
| T29 | Social Email Spoofing | Provider ایمیل جعلی برمی‌گرداند | الزام `email_verified`، بررسی دامنه، عدم Auto-link بدون تأیید |
| T30 | Context Confusion | استفاده از توکن Context ضعیف در مسیر حساس | Claim `login_context` و الزام آن در Resource Server |
| T31 | Cross-Context Escalation | انتخاب Context با نقش‌های بیشتر | فیلتر `allowed_roles` در زمان صدور توکن؛ منع `idp:*` |
| T32 | Context Parameter Tampering | تغییر `login_context` در URL | اعتبارسنجی سروری مالکیت Context و عضویت فعال |
| T33 | Translation Injection | متن مخرب یا HTML در Override | فقط متن ساده، Escape در رندر، Allowlist کلید و Placeholder |
| T34 | Translation Enumeration | افشای زبان‌ها یا کلیدهای داخلی با خطا | پاسخ عمومی، Allowlist Locale، Rate Limit |
| T35 | Locale Path Traversal | مقدار مخرب در `locale` | Allowlist Locale از Public Config؛ بدون مسیر مستقیم فایل |

## 3. کنترل‌های احراز هویت

### 3.1 رمز عبور

| کنترل | مقدار |
|---|---|
| الگوریتم Hash | Argon2id |
| پارامتر پیشنهادی | `m=64MiB, t=3, p=1` (قابل تنظیم و Benchmark) |
| Salt | تصادفی 16 بایت برای هر رمز |
| Pepper | اختیاری، در KMS |
| حداقل طول | 12 |
| حداکثر طول | 128 |
| قواعد ترکیب | بدون اجبار (NIST SP 800-63B) |
| رمزهای ممنوع | لیست رایج + ایمیل/نام کاربری |
| بررسی افشا | HIBP با k-anonymity (اختیاری) |
| تغییر اجباری دوره‌ای | خیر (مگر سیاست سازمانی) |

- سیاست Hash از محیط خوانده می‌شود (`ARGON2_MEMORY_KIB`، `ARGON2_TIME_COST`،
  `ARGON2_PARALLELISM`، `PASSWORD_PEPPER`) و یک‌بار در نقطه ترکیب ساخته می‌شود؛ همان پارامترها به
  ورود، تغییر/بازیابی رمز، رمز موقت ادمین و کدهای بازیابی MFA داده می‌شود
  (`api/src/auth/password-config.ts`).
- `PASSWORD_PEPPER` به‌عنوان Argon2 secret اعمال می‌شود و هرگز ذخیره یا لاگ نمی‌شود؛ تغییر آن بدون
  مهاجرت، همهٔ رمزهای موجود را نامعتبر می‌کند.
- پس از هر ورود موفق، اگر Hash قدیمی‌تر از سیاست فعلی باشد (پارامتر ضعیف‌تر یا بدون Pepper) با
  `needsRehash` شناسایی و بی‌صدا بازنویسی می‌شود.

### 3.2 قفل و محدودیت

| سطح | سیاست پیشنهادی |
|---|---|
| هر حساب | 5 تلاش ناموفق → قفل 15 دقیقه (تدریجی تا 24 ساعت) |
| هر IP | 20 تلاش در 10 دقیقه → محدودیت موقت |
| `/token` | 60 درخواست در دقیقه به‌ازای کلاینت |
| `/authorize` | 30 درخواست در دقیقه به‌ازای IP |
| ارسال ایمیل | 5 در ساعت به‌ازای حساب |
| OTP | 5 تلاش، سپس ابطال کد |

- پاسخ‌ها و زمان پاسخ نباید وجود حساب را افشا کنند.
- **آدرس کلاینت پشت پراکسی:** `TRUSTED_PROXY_CIDRS` به `fastify({trustProxy})` داده می‌شود؛ بدون آن `request.ip` آدرس پراکسی است و همهٔ کلاینت‌ها یک سبد Rate Limit مشترک دارند (و `ip` در Audit بی‌معنا می‌شود). فقط Peer داخل این محدوده‌ها اجازهٔ ارسال `X-Forwarded-For` دارد.
- **بودجهٔ پاسخ یکسان:** `/password/forgot` و `/email/verification/request` با بودجهٔ ثابت (`RECOVERY_RESPONSE_BUDGET_MS`) و ارسال Mail به‌صورت پس‌زمینه پاسخ می‌دهند؛ Latency انتقال Mail به پاسخ نمی‌رسد، بنابراین زمان پاسخ آدرس موجود را افشا نمی‌کند.
- هشدار به کاربر پس از ورود موفق از دستگاه جدید (اختیاری).

### 3.3 MFA

- ادمین‌ها: اجباری از روز اول.
- نقش‌های حساس: اجباری.
- کاربران عادی: اختیاری در فاز 4، قابل اجبار در فاز 5.
- WebAuthn: بررسی `origin`، `rpIdHash`، `challenge`، `signCount`.
- TOTP: پنجره ±1، Secret رمزنگاری‌شده، ضد Replay با آخرین گام.

### 3.4 ورود اجتماعی (Per-Client)

| کنترل | الزام |
|---|---|
| Credential | Client ID/Secret اختصاصی هر کلاینت؛ بدون اشتراک بین اپ‌ها |
| Secret | AES-256-GCM در KMS/Vault؛ فقط نوشتنی در API |
| Callback | `/oauth2/social/{clientId}/{provider}/callback` و تطابق دقیق |
| State/Nonce | تولید سمت سرور، یک‌بارمصرف، مقید به Client و Provider |
| PKCE | برای Providerهای پشتیبان (Google) الزامی |
| Google ID Token | بررسی امضا، `iss`، `aud == client_key`، `exp`، `nonce`، `email_verified` |
| Facebook | دریافت پروفایل با Graph API سمت سرور؛ عدم اعتماد به ورودی مرورگر |
| Account Linking | فقط با ایمیل Verified؛ بدون Auto-link برای ایمیل تأییدنشده |
| Provider Tokens | ذخیره نمی‌شوند؛ در صورت نیاز موقت و رمزنگاری‌شده |
| Admin Panel | ورود سوشال غیرفعال یا محدود به Provider سازمانی |
| Rate Limit | روی start و callback؛ پیام خطای عمومی |

### 3.5 Login Context (چند مدل ورود)

| کنترل | الزام |
|---|---|
| مالکیت Context | `login_context` باید متعلق به همان `client_id` باشد؛ در غیر این صورت رد |
| فعال‌بودن | Context غیرفعال در authorize و token پذیرفته نمی‌شود |
| عضویت | کاربر باید Membership فعال همان Context داشته باشد |
| نقش‌ها | فقط `allowed_roles` همان Context؛ نقش `idp:*` ممنوع |
| Claim | `login_context` در Access/ID Token و بررسی آن در مسیرهای حساس |
| MFA | `mfa_policy` هر Context جداگانه اعمال می‌شود |
| Step-up | Contextهای `step_up_required` بدون احراز هویت تازه توکن نمی‌دهند |
| Refresh | Refresh Token به همان Context مقید است و برای Context دیگر کار نمی‌کند |
| Audit | هر ورود/رد با `client_id` و `login_context` ثبت می‌شود |
| Admin | ادمین Context فقط به همان Context دسترسی دارد |

> Context نباید جایگزین بررسی سروری شود: Resource Server باید `login_context` را برای مسیرهای حساس الزام کند.

### 3.6 چندزبانه بودن (Localization)

| کنترل | الزام |
|---|---|
| منبع متن | فقط کلیدهای بسته پایه؛ کلید ناشناخته رد می‌شود |
| مقدار متن | متن ساده، حداکثر 500 کاراکتر؛ HTML/Script ممنوع |
| Placeholder | فقط `{name}`, `{appName}`, `{supportEmail}` |
| رندر | Escape پیش‌فرض React؛ `dangerouslySetInnerHTML` ممنوع |
| Locale | Allowlist از Public Config؛ بدون ساخت مسیر از ورودی |
| Bundle عمومی | فقط متن‌ها؛ بدون داده شخصی یا Secret |
| دسترسی | ادمین اپ فقط ترجمه اپ خودش |
| Audit | `client.locale.updated` و `client.translation.updated` |
| Cache | `ETag` بر اساس `version`؛ بدون افشای نسخه‌های دیگر |

## 4. کنترل‌های توکن

| کنترل | الزام |
|---|---|
| الگوریتم | فقط ES256 |
| `kid` | الزامی در Header |
| `aud` | شناسه کلاینت/API |
| `iss` | مقایسه دقیق با Issuer |
| عمر Access | ≤ 15 دقیقه |
| عمر ID | ≤ 10 دقیقه |
| Refresh | Opaque، Hash‌شده، چرخشی، تشخیص Reuse |
| ذخیره Refresh | Hash (Argon2id یا SHA-256 با Salt) |
| Code | Hash، یک‌بارمصرف، 60 ثانیه |
| Logout Token | امضا، `jti`، عمر ≤ 2 دقیقه |
| JWKS | Cache با `max-age`، پشتیبانی از چرخش |
| تحمل ساعت | ≤ 60 ثانیه |

**ممنوعیت‌ها:**

- پذیرش `alg=none`
- پذیرش کلید از URL دلخواه (`jku`/`x5u` بدون Allowlist)
- قرار دادن داده حساس (رمز، Secret) در Claim
- استفاده از Access Token به‌عنوان Refresh Token
- صدور Refresh Token بدون `offline_access`

## 5. کنترل‌های نشست

- کوکی: `HttpOnly; Secure; SameSite=Lax; Path=/`.
- نام کوکی بدون اطلاعات حساس.
- چرخش Session ID در ورود و Step-up.
- Idle و Absolute Timeout در [auth-flows.md](./auth-flows.md).
- ابطال فوری در تغییر رمز، غیرفعال‌سازی، حذف، یا تشخیص Reuse.
- عدم Bind سخت به IP؛ ذخیره برای Risk Assessment.
- CSRF برای Endpointهای مبتنی بر Cookie با توکن جدا و بررسی Origin.
- HSTS با `max-age` حداقل یک سال.

## 6. امنیت پنل ادمین

| کنترل | الزام |
|---|---|
| کلاینت OIDC مستقل | `admin-panel` جدا از کلاینت‌های کسب‌وکار |
| MFA | اجباری برای همه ادمین‌ها |
| Scope | فقط `openid profile idp.admin` |
| نشست | Idle 15 دقیقه / Absolute 8 ساعت |
| Step-up | برای تغییر نقش حساس، چرخش کلید، حذف کاربر |
| IP Allowlist | اختیاری برای نقش‌های ارشد |
| CSP | `default-src 'self'` و بدون `unsafe-inline` |
| Audit | همه اقدامات تغییردهنده |
| تفکیک وظایف | پشتیبانی نمی‌تواند نقش تغییر دهد |
| Export | فقط با مجوز صریح و ثبت Audit |

### 6.1 Delegated Admin (ادمین اپ)

- توکن ادمین اپ Scope `idp.client-admin` و `aud` برابر `client_id` دارد؛ سرور `clientId` مسیر را با آن تطبیق می‌دهد.
- مجوزها فقط از نوع `idp:client-*` هستند؛ نقش سراسری تخصیص نمی‌یابد.
- Scope `idp.admin` (Global) برای اپ‌های عادی صادر نمی‌شود.
- دسترسی به Client Secret، کلید امضا، تنظیمات سراسری و اپ دیگر ممنوع است.
- تغییر Provider سوشال یا نقش حساس نیازمند Step-up است.
- همه اقدامات با `actor`، `client_id` و `target` در Audit ثبت می‌شوند.
- تست منفی Cross-Client در CI الزامی است.

## 7. امنیت میکرو-فرانت‌اند

| نام میزبان | الزام |
|---|---|
| منبع Remote | فقط CDN/Origin مورد اعتماد با HTTPS |
| ورود | فقط Hosted Auth UI روی دامنه IdP؛ فرم رمز در دامنه اپ ممنوع |
| CSP | Allowlist دقیق برای `script-src` و `connect-src` |
| نسخه | Immutable و Semantic Version؛ بدون `latest` در تولید |
| یکپارچگی | کنترل انتشار، امضای Artifact و بررسی Supply Chain |
| shadcn/ui | نسخه Pin‌شده، Source-Copy، `UPSTREAM.md` و بازبینی Patchها |
| Portal | `container` داخل ریشه MFE؛ عدم رندر در `body` میزبان |
| توکن | در حالت BFF هرگز در JS میزبان نیست؛ در SPA فقط حافظه |
| رویدادها | بدون توکن/Secret؛ Schema مشخص |
| postMessage | بررسی `event.origin` و Schema |
| iframe | فقط در صورت نیاز؛ `sandbox` و Origin Allowlist |
| صفحات Hosted | `frame-ancestors 'none'` |
| ورودی | اعتبارسنجی و پرهیز از `dangerouslySetInnerHTML` |
| Fallback | صفحه Hosted امن در صورت خطای Remote |

> Module Federation امکان SRI کامل را محدود می‌کند؛ بنابراین کنترل Origin، نسخه و فرایند انتشار اهمیت بیشتری دارد.

## 8. امنیت API

- اعتبارسنجی ورودی با Schema (Zod/class-validator) و Allowlist فیلدها.
- جلوگیری از Mass Assignment.
- Deny-by-default در Authorization Guard.
- بررسی `aud`/`iss`/`exp` در همه Resource Serverها.
- محدودیت حجم Body (مثلاً 1MB) و پارامترها.
- Redaction لاگ: رمز، توکن، Cookie، Secret، کد OTP.
- CORS فقط برای Originهای ثبت‌شده و بدون Wildcard با Credentials.
- Rate Limit و Idempotency برای عملیات حساس.

## 9. رمزنگاری

| داده | روش |
|---|---|
| رمز عبور | Argon2id (یک‌طرفه) |
| Refresh Token / Code / دعوت | Hash یک‌طرفه |
| TOTP Secret | AES-256-GCM با کلید KMS |
| کلید خصوصی امضا | KMS/Vault؛ در حافظه فقط هنگام امضا |
| ارتباطات | TLS 1.2+ (ترجیح TLS 1.3)، HSTS |
| Backup | رمزنگاری‌شده (AES-256) |
| فیلدهای حساس در DB | رمزنگاری در سطح ستون (در صورت نیاز) |

- چرخش کلید رمزنگاری با نسخه‌بندی و امکان رمزگشایی داده قدیمی.
- هیچ Secretی در مخزن کد، تصویر Docker یا لاگ نباشد.

## 10. حسابرسی و پایش

### 9.1 رویدادهای الزامی

- `user.login.succeeded` / `user.login.failed`
- `user.logout.local` / `user.logout.global`
- `user.password.changed` / `user.password.reset_requested`
- `user.mfa.enrolled` / `user.mfa.removed` / `user.mfa.failed`
- `user.created` / `user.disabled` / `user.enabled` / `user.deleted`
- `role.created` / `role.updated` / `role.assigned` / `role.unassigned`
- `client.created` / `client.updated` / `client.secret_rotated`
- `session.revoked`
- `token.refresh.reuse_detected`
- `key.rotated`
- `admin.login.succeeded` / `admin.step_up`

### 9.2 هشدارهای امنیتی

هشدارها کانالی جدا از Audit هستند: Audit «چه اتفاقی افتاد» را برای انطباق نگه می‌دارد و هشدار از
اپراتور می‌خواهد همین حالا نگاه کند. پیاده‌سازی فعلی (`api/src/security/alerts.ts`) هر هشدار را
هم به‌صورت یک خط ساختاریافتهٔ `security-alert` در لاگ و هم به‌صورت شمارندهٔ
`idpn_security_alerts_total{type,severity}` منتشر می‌کند تا قاعدهٔ Prometheus و Runbook روی آن
عمل کنند؛ ارسال به Pager فقط با تزریق یک Sink دیگر لازم است و هرگز نمی‌تواند پاسخ احراز هویت را
خراب کند. هشدارهای پیاده‌شده: قفل حساب به‌دلیل کدهای نادرست مرحلهٔ دوم (`mfa.lockout`، شدت بالا) و
تمام‌شدن بودجهٔ چالش (`mfa.challenge_exhausted`، متوسط).

| رخداد | شدت |
|---|---|
| Refresh Token Reuse | بحرانی |
| افزایش ناگهانی ورود ناموفق | بالا |
| ورود موفق از کشور/دستگاه جدید برای ادمین | بالا |
| تغییر نقش `idp:superadmin` | بالا |
| خطای اعتبارسنجی امضا در Resource Server | بالا |
| حجم غیرعادی درخواست `/token` | متوسط |
| خطای ارسال Back-channel Logout | متوسط |

### 9.3 نگهداشت و دسترسی

- Audit فقط Append؛ بدون Update/Delete از طریق API.
- دسترسی خواندن با مجوز `idp:audit:read`.
- Export با مجوز جدا و Audit.
- نگهداشت 12 ماه (قابل تنظیم).

## 11. حریم خصوصی

- حداقل‌سازی داده: فقط فیلدهای لازم جمع‌آوری شوند.
- عدم درج PII در Claimهای غیرضروری.
- Mask کردن ایمیل/موبایل در نمایش‌های پشتیبانی.
- حق حذف حساب با ناشناس‌سازی Audit.
- سیاست نگهداشت مطابق [domain-model.md](./domain-model.md).
- رضایت (Consent) برای Scopeهای حساس و کلاینت‌های ثالث.

## 12. امنیت عملیاتی

- تصاویر Docker حداقلی (Distroless/Alpine)، بدون Root.
- اسکن آسیب‌پذیری در CI (Dependency + Container).
- SBOM تولید و نگهداری.
- وابستگی‌های shadcn/ui، Tailwind و Radix Pin و اسکن شوند.
- CLI shadcn فقط در محیط کنترل‌شده اجرا شود؛ نسخه و لایسنس ثبت شود.
- مدیریت Secret با Vault/KMS.
- Backup رمزنگاری‌شده + تست بازیابی.
- دسترسی به سرور با Bastion و MFA.
- Log متمرکز و Tamper-evident.
- مستند Runbook برای حوادث امنیتی.
- تست نفوذ قبل از انتشار عمومی (فاز 6).

## 13. چک‌لیست پذیرش امنیتی

- [ ] PKCE برای همه کلاینت‌ها اجباری است.
- [ ] Redirect URI فقط Exact Match است.
- [ ] `state` و `nonce` بررسی می‌شوند.
- [ ] Code یک‌بارمصرف و کوتاه‌عمر است.
- [ ] Refresh Token چرخشی با تشخیص Reuse است.
- [ ] Access Token فقط ES256 و با `kid` است.
- [ ] JWKS قابل چرخش و Cache صحیح دارد.
- [ ] رمزها با Argon2id ذخیره می‌شوند.
- [ ] Rate Limit و قفل حساب فعال است.
- [ ] پیام‌ها Account Enumeration را ممکن نمی‌کنند.
- [ ] کوکی‌ها `HttpOnly; Secure; SameSite` دارند.
- [ ] CSRF و Origin برای Endpointهای Cookie-based بررسی می‌شود.
- [ ] MFA برای ادمین‌ها اجباری است.
- [ ] Step-up برای عملیات حساس فعال است.
- [ ] همه رویدادهای حساس Audit می‌شوند.
- [ ] لاگ‌ها Redaction دارند.
- [ ] Secretها در KMS/Vault هستند.
- [ ] CSP و HSTS فعال است.
- [ ] وابستگی‌ها و تصاویر اسکن می‌شوند.
- [ ] Backup و بازیابی تست شده است.
- [ ] مستند حادثه و تماس اضطراری وجود دارد.
- [ ] هر کلاینت Credential سوشال جداگانه و رمزنگاری‌شده دارد.
- [ ] اتصال سوشال فقط با ایمیل Verified انجام می‌شود.
- [ ] Callback سوشال مقید به `clientId` و `provider` است.
- [ ] Public Config هیچ Secret یا داده حساسی برنمی‌گرداند.
- [ ] MFE فقط از Origin نسخه‌دار و مورد اعتماد بارگذاری می‌شود.
- [ ] CSS/Preflight در MFE ایزوله است و به Host نشت نمی‌کند.
- [ ] Radix Portalها داخل ریشه MFE رندر می‌شوند.
- [ ] shadcn/ui و Tailwind Pin و در SBOM ثبت شده‌اند.
- [ ] RTL فارسی و axe در کامپوننت‌های shadcn تست شده‌اند.
- [ ] رویدادهای MFE هیچ توکنی افشا نمی‌کنند.
- [ ] Delegated Admin در تست منفی به داده اپ دیگر دسترسی ندارد.
- [ ] `suspended` شدن Membership توکن‌های همان اپ را باطل می‌کند.
- [ ] Context فقط نقش‌های `allowed_roles` خودش را می‌دهد و `idp:*` صادر نمی‌کند.
- [ ] Resource Server برای مسیرهای حساس `login_context` را الزام می‌کند.
- [ ] `login_context` نامعتبر یا متعلق به اپ دیگر رد می‌شود.
- [ ] متن‌های ترجمه فقط متنی و Escape‌شده رندر می‌شوند.
- [ ] Locale فقط از Allowlist پذیرفته می‌شود.
- [ ] تغییر Context و ترجمه Audit و Step-up دارد.
- [ ] تغییر Provider سوشال و نقش حساس Audit و Step-up دارد.
