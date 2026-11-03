# چندزبانه بودن (Localization) به‌ازای هر اپلیکیشن

> هدف: هر اپلیکیشنی که از IdP استفاده می‌کند، زبان، جهت متن، فونت و متن‌های خودش را داشته باشد؛ بدون Fork کردن UI و بدون کپی کد.

## 1. دامنه

| در دامنه | خارج از دامنه |
|---|---|
| زبان رابط Hosted Auth UI و MFE به‌ازای هر `client_id` | ترجمه محتوای اپلیکیشن میزبان (خارج از احراز هویت) |
| انتخاب زبان توسط کاربر و ذخیره در پروفایل | سیستم مدیریت ترجمه مستقل برای بازاریابی |
| RTL/LTR خودکار بر اساس Locale | ترجمه خودکار ماشینی در Runtime |
| تاریخ، عدد و واحد پول با Locale | تقویم‌های سفارشی خارج از Intl |
| متن‌های اختصاصی هر اپ روی متن‌های پایه | تغییر ساختار صفحه توسط اپ |

## 2. زبان‌های پایه و قابل افزودن

| Locale | جهت | فونت | وضعیت |
|---|---|---|---|
| `fa-IR` | RTL | Vazirmatn | پایه و پیش‌فرض |
| `en-US` | LTR | Inter / system UI | پایه |
| `ar-SA` | RTL | Noto Sans Arabic | قابل فعال‌سازی |
| `tr-TR` | LTR | Inter | قابل فعال‌سازی |

- زبان‌های پایه در بسته مشترک نگهداری می‌شوند.
- هر اپ فقط زبان‌هایی را فعال می‌کند که **همه** کلیدهای لازم را دارند؛ در غیر این صورت در زمان انتشار خطا می‌گیرد.
- زبان‌های راست‌به‌چپ به‌صورت خودکار `dir="rtl"` می‌گیرند.

## 3. زنجیره تعیین زبان

ترتیب اولویت (اولین مقدار معتبر برنده است):

1. پارامتر `ui_locales` در `/authorize`
2. `Accept-Language` مرورگر (فقط اگر Locale فعال همان اپ باشد)
3. `locale` ذخیره‌شده در پروفایل کاربر
4. `defaultLocale` کلاینت
5. `defaultLocale` سازمان (Tenant)
6. `fa-IR`

قواعد:

- مقدار نامعتبر یا غیرفعال هرگز باعث خطا نمی‌شود؛ به مرحله بعد سقوط می‌کند.
- اگر کاربر زبان اپ را تغییر دهد، در پروفایل او ذخیره می‌شود **اما** فقط برای همان کلاینت اعمال می‌شود (زبان‌ها می‌توانند per-client باشند).
- `ui_locales` فقط برای همان درخواست معتبر است و در پروفایل ذخیره نمی‌شود.
- زبان انتخاب‌شده در `id_token` به‌صورت Claim اختیاری `locale` منتشر می‌شود.

## 4. لایه‌های متن

```
بسته پایه (IdP)          ← کلیدهای مشترک مثل login.title, login.submit
   ↓ override
متن اختصاصی کلاینت       ← «ورود به پنل مشتریان»
   ↓ override
متن اختصاصی Context      ← «ورود مدیر مشتری» (اختیاری)
```

- **کلیدها ثابت‌اند**؛ اپ فقط مقدار می‌دهد.
- اپ نمی‌تواند کلید جدید بسازد (کلید ناشناخته در API رد می‌شود). کلید جدید ابتدا در بسته پایه اضافه می‌شود.
- مقدار متن فقط متن ساده است؛ HTML، Script و Event Handler مجاز نیست.
- Placeholder مجاز: `{name}`، `{appName}`، `{supportEmail}`؛ بقیه رد می‌شود.

### نمونه کلیدهای پایه

| کلید | fa-IR | en-US |
|---|---|---|
| `login.title` | ورود | Sign in |
| `login.subtitle` | برای ادامه وارد شوید | Sign in to continue |
| `login.username` | نام کاربری یا ایمیل | Username or email |
| `login.password` | رمز عبور | Password |
| `login.submit` | ورود | Sign in |
| `login.forgot` | رمز عبور را فراموش کرده‌اید؟ | Forgot password? |
| `login.social.google` | ورود با Google | Continue with Google |
| `login.social.facebook` | ورود با Facebook | Continue with Facebook |
| `login.error.invalid` | نام کاربری یا رمز عبور نادرست است | Invalid username or password |
| `login.error.locked` | حساب موقتاً قفل شده است | Account is temporarily locked |
| `mfa.title` | تأیید دومرحله‌ای | Two-step verification |
| `mfa.code` | کد تأیید | Verification code |
| `consent.title` | دسترسی‌های درخواستی | Requested access |
| `logout.title` | از حساب خارج شدید | You have been signed out |

> فهرست کامل در بسته پایه (`packages/i18n/messages/{locale}.json`) نگهداری می‌شود و همان منبع اعتبارسنجی است.

## 5. قالب پیام

```json
{
  "login.title": "ورود",
  "login.subtitle": "برای ادامه به {appName} وارد شوید",
  "login.attempts": "{count, plural, one {یک تلاش} other {# تلاش}}"
}
```

- از ICU MessageFormat برای جمع و انتخاب استفاده می‌شود.
- اعداد و تاریخ داخل پیام با `Intl` همان Locale فرمت می‌شوند.
- پیام نباید شامل داده حساس باشد؛ فقط Placeholderهای مجاز.

## 6. قرارداد تنظیمات

### 6.1 Public Config

```json
{
  "clientId": "app-a",
  "locales": {
    "default": "fa-IR",
    "supported": ["fa-IR", "en-US"],
    "dir": { "fa-IR": "rtl", "en-US": "ltr" },
    "version": "2026-10-18T12:00:00Z"
  },
  "fonts": {
    "fa-IR": "Vazirmatn",
    "en-US": "Inter"
  },
  "translationsUrl": "https://auth.example.com/api/v1/clients/app-a/translations/bundle"
}
```

- `version` مبنای Cache است؛ با هر تغییر متن عوض می‌شود.
- فونت‌ها فقط از Allowlist مجاز انتخاب می‌شوند.

### 6.2 Bundle عمومی

```
GET /api/v1/clients/{clientId}/translations/bundle?locale=fa-IR
```

```json
{
  "locale": "fa-IR",
  "dir": "rtl",
  "version": "2026-10-18T12:00:00Z",
  "messages": {
    "login.title": "ورود به پنل مشتریان",
    "login.submit": "ورود"
  }
}
```

- فقط کلیدهای بسته پایه برمی‌گردند؛ هیچ داده داخلی یا Secret.
- `ETag` + `Cache-Control: public, max-age=300`.
- درخواست `locale` غیرفعال → `404` با بدنه عمومی، بدون افشای زبان‌های دیگر.

## 7. مدیریت ترجمه

| متد | مسیر | مجوز |
|---|---|---|
| GET | `/api/v1/clients/{clientId}/translations` | `idp:client-locale:read` |
| GET | `/api/v1/clients/{clientId}/translations/{locale}` | `idp:client-locale:read` |
| PUT | `/api/v1/clients/{clientId}/translations/{locale}` | `idp:client-locale:write` |
| DELETE | `/api/v1/clients/{clientId}/translations/{locale}` | `idp:client-locale:write` |
| GET | `/api/v1/clients/{clientId}/locales` | `idp:client-locale:read` |
| PUT | `/api/v1/clients/{clientId}/locales` | `idp:client-locale:write` |

**به‌روزرسانی متن:**

```json
{
  "messages": {
    "login.title": "ورود به پنل مشتریان",
    "login.subtitle": "برای ادامه به پنل مشتریان وارد شوید"
  }
}
```

قواعد:

- کلید ناشناخته → `422` با فهرست کلیدهای نامعتبر.
- متن خالی → حذف Override و بازگشت به مقدار پایه.
- مقدار بیش از 500 کاراکتر → `422`.
- تغییر Locale پیش‌فرض نیازمند این است که بسته آن Locale کامل باشد.
- همه تغییرات Audit می‌شوند (`client.locale.updated`, `client.translation.updated`).
- ادمین اپ فقط برای `clientId` خودش مجاز است؛ ادمین سراسری می‌تواند بسته پایه را ویرایش کند.

## 8. RTL و چیدمان

- `DirectionProvider` رادیکس در ریشه Hosted UI و MFE با مقدار `dir` همان Locale.
- استفاده از Utilityهای منطقی: `ps-*`/`pe-*`، `ms-*`/`me-*`، `start-*`/`end-*`، `text-start`/`text-end`.
- آیکون‌های جهت‌دار در RTL چرخانده می‌شوند (`rtl:rotate-180`).
- اعداد لاتین در متن فارسی مجاز است؛ اعداد فارسی با `Intl.NumberFormat('fa-IR')`.
- تاریخ شمسی با `Intl.DateTimeFormat('fa-IR-u-ca-persian')`.
- فونت هر Locale روی ریشه MFE تنظیم می‌شود و نباید از فونت Host ارث ببرد.
- تست Screenshot برای هر دو جهت الزامی است.

## 9. تاریخ، عدد و واحد پول

| داده | روش |
|---|---|
| تاریخ | `Intl.DateTimeFormat(locale, { calendar })` — `fa-IR` با `persian` |
| عدد | `Intl.NumberFormat(locale)` |
| واحد پول | `Intl.NumberFormat(locale, { style: 'currency', currency })` |
| زمان نسبی | `Intl.RelativeTimeFormat(locale)` |
| منطقه زمانی | ذخیره UTC؛ نمایش با منطقه کاربر یا کلاینت |

- هیچ فرمت دستی با `toLocaleString()` بدون Locale صریح مجاز نیست.
- تقویم پیش‌فرض هر کلاینت قابل تنظیم است (`gregorian` یا `persian`).

## 10. یکپارچگی با MFE

- Locale از Config میزبان می‌آید (`locale`, `locales`) و از Public Config کامل می‌شود.
- تغییر زبان توسط کاربر رویداد `locale:changed` منتشر می‌کند تا میزبان هم هماهنگ شود.
- MFE نباید زبان Host را بخواند یا تغییر دهد؛ فقط Locale خودش را مدیریت می‌کند.
- متن‌های اپ میزبان خارج از دامنه MFE است.
- در حالت Web Component، `lang` و `dir` روی `:host` تنظیم می‌شوند.

```ts
export interface IdpnLocaleConfig {
  locale: string;
  supported: string[];
  dir: Record<string, 'rtl' | 'ltr'>;
}
```

## 11. کارایی

| شاخص | هدف |
|---|---|
| حجم هر Bundle | ≤ 20KB gzip |
| بارگذاری Bundle | فقط Locale فعال + Lazy برای تغییر زبان |
| Cache | `ETag` و Immutable per `version` |
| تغییر زبان | بدون Reload کامل صفحه |

## 12. امنیت

- متن ترجمه به‌عنوان **داده** رندر می‌شود، نه HTML.
- `dangerouslySetInnerHTML` برای پیام‌ها ممنوع است.
- Placeholderها فقط از Allowlist؛ مقدار ورودی کاربر هرگز داخل پیام تزریق نمی‌شود مگر Escape شود.
- طول متن و تعداد کلید محدود است (جلوگیری از DoS).
- فقط کلیدهای شناخته‌شده پذیرفته می‌شوند (جلوگیری از تزریق کلید و افشا).
- تغییر متن Audit می‌شود؛ ادمین اپ فقط اپ خودش.
- Bundle عمومی هیچ داده شخصی یا Secret ندارد.
- Locale در URL/پارامتر با Allowlist اعتبارسنجی می‌شود (بدون Path Traversal).

## 13. تست

| ID | تست |
|---|---|
| LOC-001 | زنجیره تعیین زبان به‌ترتیب درست عمل می‌کند |
| LOC-002 | Locale غیرفعال به مرحله بعد سقوط می‌کند |
| LOC-003 | کلید ناشناخته در API رد می‌شود |
| LOC-004 | کلید موجود در بسته پایه و اپ Override می‌شود |
| LOC-005 | حذف Override به مقدار پایه بازمی‌گردد |
| LOC-006 | متن HTML/سcript رد یا Escape می‌شود |
| LOC-007 | RTL در فرم، Dialog و جدول درست است |
| LOC-008 | تاریخ شمسی و اعداد فارسی درست فرمت می‌شوند |
| LOC-009 | تغییر زبان بدون Reload و بدون از دست رفتن State |
| LOC-010 | Bundle با `ETag` درست Cache می‌شود |
| LOC-011 | ادمین اپ به ترجمه اپ دیگر دسترسی ندارد |
| LOC-012 | axe و Visual Regression برای fa-IR و en-US |

## 14. چک‌لیست پذیرش

- [ ] زبان هر اپ از Public Config خوانده می‌شود.
- [ ] زنجیره تعیین زبان پیاده و تست شده است.
- [ ] کاربر می‌تواند زبان را تغییر دهد و انتخابش برای همان اپ ذخیره می‌شود.
- [ ] RTL/LTR خودکار و تست‌شده است.
- [ ] تاریخ شمسی، اعداد و واحد پول با `Intl` فرمت می‌شوند.
- [ ] متن اختصاصی اپ بدون Fork و فقط با Override اعمال می‌شود.
- [ ] کلید ناشناخته و متن ناامن رد می‌شود.
- [ ] تغییر ترجمه Audit می‌شود.
- [ ] Bundle عمومی هیچ داده حساسی ندارد.
- [ ] تست‌های LOC-001 تا LOC-012 سبز هستند.
