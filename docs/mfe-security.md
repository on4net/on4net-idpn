# امنیت MFE و CSP

> این سند مرجع عملی بخش «امنیت MFE» در [security.md](./security.md) و بخش ۱۲
> [micro-frontend.md](./micro-frontend.md) است. منبع واحد سیاست در کد:
> `web/src/security/headers.ts` (هدرها) و `web/src/security/remote-cors.ts` (Allowlist منبع Remote).

## ۱. ماتریس CSP

| سرویس | `script-src` | `style-src` | `connect-src` | `frame-ancestors` |
|---|---|---|---|---|
| Hosted Auth UI (تولید) | `'self'` | `'self' 'unsafe-inline'` | `'self'` + Originهای IdP/API | `'none'` |
| Hosted Auth UI (dev) | `'self' 'unsafe-inline'` | `'self' 'unsafe-inline'` | `'self'` + API + `ws:`/`wss:` | `'none'` |
| میزبان Module Federation | `'self'` + Origin دقیق CDN | `'self' 'unsafe-inline'` | `'self'` + API/IdP + CDN | `'none'` |
| Remote / Asset CDN | `'self'` | `'self' 'unsafe-inline'` | `'self'` | `'none'` |

- هیچ‌جا `'unsafe-eval'` مجاز نیست؛ Vite در حالت dev فقط `'unsafe-inline'` را برای
  preamble خود اضافه می‌کند و همان هم در تولید حذف می‌شود.
- `style-src` شامل `'unsafe-inline'` است چون React/Radix استایل را به‌صورت
  style attribute می‌نویسند و shadcn/ui با Tailwind v4 به‌صورت source-copy استفاده می‌شود.
  در صورت مهاجرت به nonce، این بند باید هم‌زمان با تست Visual تغییر کند.
- `frame-ancestors 'none'` برای Hosted UI الزام امنیتی است (T16). اگر روزی Logout در
  iframe لازم شد، فقط همان مسیر با سیاست جداگانه و `sandbox` مجاز می‌شود.
- `X-Frame-Options: DENY` فقط برای مرورگرهای قدیمی نگه داشته می‌شود.

هدرهای پایه: `X-Content-Type-Options: nosniff`، `Referrer-Policy: no-referrer`،
`Permissions-Policy` محدود، و `Cross-Origin-Opener-Policy: same-origin`. برای Remote،
`Cross-Origin-Resource-Policy: cross-origin` لازم است تا میزبان بتواند ماژول را import کند.

## ۲. محل اعمال

- dev/preview: `web/vite.config.ts`، `web/vite.host.config.ts` و `web/vite.mfe.config.ts`
  هدرها را از `buildSecurityHeaders()` می‌گیرند. بنابراین تست E2E
  (`e2e/web/security-headers.spec.ts`) همان سیاستی را می‌بیند که تولید می‌بیند.
- تولید: لبه (Nginx/Caddy) یا CDN باید همین مجموعه را ست کند. نمونه‌های کامل:
  [`deploy/security/nginx.conf.example`](../deploy/security/nginx.conf.example) و
  [`deploy/security/Caddyfile.example`](../deploy/security/Caddyfile.example).
- API هدرهای پایه خود را دارد و در همان مسیر JSON/Redirect ارسال می‌کند؛ CSP صفحه
  مسئولیت لبه است.

## ۳. Trusted Types

- وضعیت فعلی: **Report-Only**:
  `require-trusted-types-for 'script'; trusted-types idpn 'allow-duplicates'`.
  این هدر مانع اجرا نمی‌شود و فقط نقض‌ها را گزارش می‌کند.
- پس از یک بازه انتشار بدون نقض (حداقل یک چرخه Release)، همین دستور به
  `Content-Security-Policy` اصلی منتقل می‌شود.
- قواعد کد: `dangerouslySetInnerHTML`، `innerHTML`/`outerHTML` (به‌صورت نوشتن)،
  `eval`، `new Function` و `document.write` ممنوع‌اند. تست
  `web/src/security/security-source-scan.test.ts` این موارد را روی AST بررسی می‌کند.
- استثناها فقط با یک policy نام‌دار (`idpn`) و بازبینی امنیتی اضافه می‌شوند؛ هرگز
  `trusted-types *`.

## ۴. SRI و نسخه Immutable

Module Federation در زمان اجرا `remoteEntry.js` و chunkهای بعدی را از CDN می‌خواند؛
بنابراین SRI کامل روی `remoteEntry.js` عملی نیست (هش chunkها از قبل معلوم نیست). کنترل
جایگزین:

1. **Origin Allowlist**: فقط Originهای ثبت‌شده در `MFE_ALLOWED_ORIGINS` (سمت dev/preview)
   یا `Access-Control-Allow-Origin` دقیق (سمت CDN). درخواست با Origin ناشناس در dev/preview
   با `403` رد می‌شود و هرگز `*` ست نمی‌شود.
2. **نسخه پین‌شده و Immutable**: مسیر `.../idpn-mfe/{version}/remoteEntry.js` با
   `Cache-Control: public, max-age=31536000, immutable`؛ نسخه `latest` در تولید ممنوع.
3. **Manifest کوتاه‌عمر** برای کشف نسخه سازگار و Rollback.
4. **امضای Artifact و SBOM** در خط انتشار (بخش Supply Chain در
   [security.md](./security.md) و `pnpm sbom`).
5. برای تحویل **Web Component** (فایل مستقل، بدون federation) SRI عملی است:
   `<script type="module" src="…/web-component-1.4.0.js" integrity="sha384-…" crossorigin="anonymous">`.
   هش باید در همان Release تولید و در HTML میزبان پین شود.

## ۵. توکن و postMessage

- BFF (پیش‌فرض): توکن در JavaScript میزبان نیست؛ فقط کوکی نشست همان Origin.
- SPA (فقط میزبان مورد اعتماد): توکن در حافظه و از طریق `getAccessToken()`؛ هیچ نوشتن
  `localStorage`/`sessionStorage`/URL/Attribute مجاز نیست (تست اسکن منبع).
- رویدادهای MFE فقط داده غیرحساس دارند (`docs/micro-frontend.md` 6) و اسکن منبع هر
  `localStorage`/`sessionStorage` را در کد UI رد می‌کند.
- در حال حاضر MFE از `postMessage` استفاده نمی‌کند. اگر در آینده اضافه شد:
  `event.origin` باید دقیقاً با یک Origin Allowlist مقایسه شود، `event.source` بررسی شود،
  payload با Schema اعتبارسنجی شود و `postMessage(..., '*')` ممنوع است (تست اسکن منبع
  این الگو را رد می‌کند).

## ۶. بررسی خودکار

```powershell
pnpm test:security   # vitest: header/CORS unit + source scan + Trusted Types/secret scan
pnpm test:e2e        # شامل e2e/web/security-headers.spec.ts
pnpm audit:ci
pnpm supply-chain
```

CI: job `mfe-security` (سریع، بدون مرورگر) و job `supply-chain` (Audit، SBOM، Pin/License).

## ۷. چک‌لیست انتشار

- [ ] CSP تولید دقیقاً از `buildSecurityHeaders()` گرفته شده و `unsafe-eval` ندارد.
- [ ] Origin دقیق CDN در `script-src` میزبان و در CORS مجاز است؛ هیچ `*` وجود ندارد.
- [ ] `remoteEntry.js` روی مسیر نسخه‌دار Immutable سرو می‌شود و manifest کوتاه‌عمر دارد.
- [ ] Report-Only مربوط به Trusted Types فعال است و گزارش‌ها بررسی می‌شوند.
- [ ] `pnpm test:security` و `pnpm test:e2e` سبز هستند.
- [ ] SBOM و بررسی وابستگی برای همان Commit تولید شده است.
