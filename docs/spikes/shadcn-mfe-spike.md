# Spike: shadcn/ui + Tailwind v4 در MFE (کارت #50)

> وضعیت: **در جریان** — بخش Hosted Login، ایزولاسیون Web Component، RTL و A11y پاس شد؛
> Mount ماژول Remote در یک Host مستقل (Module Federation) هنوز باقی است.

## 1. آنچه ساخته شد

| بخش | مسیر | وضعیت |
|---|---|---|
| اپ Hosted (ورود) | `web/index.html`، `web/src/main.tsx`، `web/src/app/login-page.tsx` | ✅ |
| ریشه مشترک + Portal | `web/src/app/idpn-root.tsx` (`DirectionProvider`، `.idpn-root`، `idpn-portal-root`) | ✅ |
| کامپوننت‌های shadcn-style | `web/src/components/ui/{button,input,label,dialog,select}.tsx` | ✅ |
| ماژول MFE | `web/src/mfe/user-management.tsx` | ✅ |
| Web Component | `web/src/mfe/web-component.tsx` (`<on4net-idpn-user-management>` + Shadow DOM) | ✅ |
| Remote (Module Federation) | `web/vite.mfe.config.ts` → `dist-mfe/remoteEntry.js` | ✅ Build |
| Host fixture با CSS مستقل | `web/host/*` (HTML + CSS عمداً مهاجم) | ✅ |
| تست E2E | `e2e/web/login.spec.ts`، `e2e/web/isolation.spec.ts` | ✅ ۶ تست |

## 2. یافته‌ها

### Preflight و نشت CSS

- Tailwind v4 در حالت پیش‌فرض `preflight` را به `base` تزریق می‌کند و Host را Reset می‌کند.
- راه‌حل تأییدشده: ایمپورت نکردن Preflight و فقط استفاده از تم/Utilities:

```css
@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/utilities.css' layer(utilities);
```

- در تست ایزولاسیون، Host با فونت `Georgia`، `h1` با `40px`، دکمه با `rgb(200,0,0)`، `.flex{display:block}` و
  `.p-4{padding:1px}` هیچ تغییری نگرفت؛ یعنی نه Reset و نه Utilities سراسری روی Host اثر نگذاشتند.

### Shadow DOM

- تمام CSS (شامل توکن‌ها) داخل `shadowRoot` تزریق می‌شود؛ Portalهای Radix هم داخل همان ریشه رندر می‌شوند
  (`document.body` خالی از `[role=dialog]` است) — تست خودکار این را بررسی می‌کند.
- از `:host` استفاده نشد؛ به‌جای آن `.idpn-root` داخل Shadow Root نگه داشته شد تا رفتار Hosted و Remote یکسان بماند.

### Portal

- `Dialog` و `Select` یک prop اختیاری `container` می‌گیرند و مقدار را از `usePortalContainer()` می‌گیرند؛
  بنابراین در Hosted UI و MFE و Shadow DOM همه‌جا داخل `.idpn-root` می‌مانند.

### RTL

- `DirectionProvider` از Radix در ریشه مشترک؛ `dir`/`lang` روی همان ریشه.
- Utilityهای Logical (`start-*`، `text-start`، `ps-*`) استفاده شد؛ برای Dialog از `flex` مرکزی استفاده شد
  تا `translate-x` جهت‌دار مشکل ایجاد نکند.

### Accessibility

- axe در Chromium ابتدا یک خطای **serious** از نوع `color-contrast` روی دکمه اصلی پیدا کرد
  (`--primary: oklch(0.55 …)` با متن سفید). با تیره‌کردن توکن به `oklch(0.48 …)` رفع شد و اکنون
  هیچ خطای Critical/Serious روی Hosted Login و صفحه Host وجود ندارد.
- Keyboard: Tab بین فیلدها، Enter برای Submit، Escape برای بستن Dialog و بازگشت Focus به Trigger تست می‌شود.

### اندازه Bundle (Production)

| خروجی | حجم | gzip |
|---|---|---|
| Hosted Login (`dist/`) | 462 KB JS + 10.8 KB CSS | 145 KB + 2.6 KB |
| Remote (`dist-mfe/remoteEntry.js` + chunks) | حدود 560 KB مجموع | حدود 163 KB |
| Web Component (`dist-wc/web-component.js`) | 986 KB | 250 KB |

- Remote با `shared: { react: { singleton: true }, 'react-dom': { singleton: true } }` ساخته می‌شود.
- Web Component چون React را درون خود دارد سنگین‌تر است؛ برای Hostهای غیر-React همین انتظار می‌رود و
  در فاز انتشار باید Code-splitting/Lazy-loading ماژول‌ها بررسی شود.

## 3. باقی‌مانده

- Mount واقعی `idpnMfe/UserManagement` در یک Host React با Module Federation runtime و Tailwind مستقل
  (شامل بررسی React 19 Singleton در Runtime، نه فقط در Build).
- اندازه‌گیری دقیق Bundle پس از Lazy-loading ماژول‌ها.
- ثبت تصمیم نهایی Go/No-Go در `docs/design-system.md` پس از تکمیل مورد بالا (این فایل فعلاً تغییر
  uncommitted کاربر را دارد و در همان زمان با هم Merge می‌شود).

## 4. نتیجه موقت

**Go** برای: Hosted Login با shadcn/ui، Portal داخل ریشه، RTL، axe و ایزولاسیون Web Component.
**باز** برای: تأیید نهایی Module Federation در Host.
