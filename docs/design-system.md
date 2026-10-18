# Design System — shadcn/ui

> **تصمیم:** **shadcn/ui** به‌عنوان Design System فرانت‌اند انتخاب شد؛ همراه با **React 19**، **Tailwind CSS v4** و **Radix UI**.
> مدل استفاده: **Vendored / Source-Copy**؛ کد کامپوننت‌ها داخل مخزن ما نگهداری و نسخه‌ها Pin می‌شوند.

## 1. چرا shadcn/ui

| معیار | ارزیابی |
|---|---|
| هم‌خوانی با استک | React 19 + Vite + Tailwind v4 + Radix UI |
| بلوغ و اکوسیستم | بالغ‌ترین گزینه Source-Copy با Radix + Tailwind؛ جامعه و Registry بزرگ |
| Accessibility | مبتنی بر Radix UI؛ مناسب فرم، Dialog، Select و Table |
| مالکیت کد | Source-Copy؛ بدون Runtime Dependency و بدون Lock-in |
| RTL | پشتیبانی بهتر در نسخه‌های اخیر؛ همچنان نیازمند Audit نهایی |
| بلوک‌های آماده | Login، Signup، Sidebar و Dashboard از طریق Registry |
| طراحی | CSS Variables، OKLCH و Dark Mode |
| لایسنس | MIT |
| محدودیت | Figma Kit رسمی و بلوک‌های Auth اختصاصی ندارد؛ اما Registry و Community غنی است |

## 2. نسخه‌ها و پیش‌نیازها

| مورد | نسخه/الزام |
|---|---|
| React / ReactDOM | 19.x (در همه Hostهای React یکسان) |
| Tailwind CSS | v4 با `@tailwindcss/vite` |
| shadcn CLI | `shadcn@4.22.0` (فقط زمان Scaffold/Add؛ Pin شود) |
| Vite | نسخه پایدار فعلی پروژه |
| TypeScript | Strict |
| Alias | `@/*` طبق `components.json` |

- نسخه CLI و کامپوننت‌ها در `UPSTREAM.md` ثبت می‌شود.
- Lockfile الزامی است؛ به‌روزرسانی خودکار ممنوع.
- shadcn در Runtime نصب نمی‌شود؛ فقط Source کامپوننت‌ها در مخزن است.

## 3. مالکیت و Governance

### ساختار پیشنهادی

```
packages/ui/                  # یا web/src/components/ui
  components/ui/              # کامپوننت‌های shadcn
  styles/globals.css           # CSS Variables و توکن‌های Semantic
  lib/utils.ts                # cn()
  components.json
  UPSTREAM.md                 # نسخه، تاریخ، Patchها
```

### قواعد

1. هر کامپوننت مصرف‌شده در `UPSTREAM.md` با نسخه مبدأ ثبت شود.
2. تغییرات ما در بخش `Local patches` ثبت شود تا هنگام Upgrade قابل بازبینی باشد.
3. افزودن کامپوننت جدید فقط با CLI و نسخه Pin‌شده انجام شود:
   `npx shadcn@4.22.0 add button input form dialog select table`
4. کامپوننت بدون تست و بدون بررسی RTL/A11y وارد نشود.
5. حذف یا تغییر نام کامپوننت‌ها فقط با به‌روزرسانی همه مصرف‌کننده‌ها.
6. کد کامپوننت‌ها مال ماست؛ اما رفتار عمومی و Accessibility آن نباید بی‌دلیل تغییر کند.
7. از Registryهای شخص ثالث فقط پس از بازبینی کد و لایسنس استفاده شود.

## 4. معماری توکن‌ها

سه لایه:

1. **Primitive:** پالت OKLCH در `globals.css` (shadcn).
2. **Semantic:** متغیرهای shadcn (`--background`, `--foreground`, `--primary`, ...) و لایه `--idpn-*` برای برند.
3. **Component:** متغیرهای محلی کامپوننت در صورت نیاز.

```css
:root {
  --idpn-bg: var(--background);
  --idpn-fg: var(--foreground);
  --idpn-primary: var(--primary);
  --idpn-primary-fg: var(--primary-foreground);
  --idpn-border: var(--border);
  --idpn-radius: var(--radius);
  --idpn-font-sans: "Vazirmatn", system-ui, sans-serif;
}
```

### قواعد رنگ

- استفاده از رنگ‌های پیش‌فرض Tailwind (`bg-red-500`, `text-slate-500`) ممنوع است.
- فقط توکن‌های shadcn یا `--idpn-*` استفاده شود.
- کنتراست حداقل WCAG AA رعایت شود.
- Dark Mode از طریق کلاس `.dark` و توکن‌های Semantic.

## 5. تم هر اپلیکیشن

- `Client.branding` در IdP شامل `logoUrl`، `primaryColor`، `radius` و در صورت نیاز فونت است.
- Public Config این مقادیر را به MFE می‌دهد.
- MFE آن‌ها را به CSS Variables روی ریشه خودش Map می‌کند:

```ts
root.style.setProperty("--primary", config.theme.primary);
root.style.setProperty("--idpn-primary", config.theme.primary);
root.style.setProperty("--radius", config.theme.radius);
```

- Fallback امن برای همه مقادیر.
- هیچ اپی کامپوننت‌ها را Fork نمی‌کند؛ فقط Theme می‌دهد.
- تست کنتراست برای هر Theme الزامی است.

## 6. RTL و i18n

### الزامات

- `DirectionProvider` از Radix در ریشه MFE و Hosted UI.
- `dir="rtl"` برای فارسی و `dir="ltr"` برای انگلیسی.
- استفاده از Utilityهای Logical:
  - `ps-*` / `pe-*` به‌جای `pl-*` / `pr-*`
  - `ms-*` / `me-*` به‌جای `ml-*` / `mr-*`
  - `start-*` / `end-*` به‌جای `left-*` / `right-*`
  - `text-start` / `text-end` به‌جای `text-left` / `text-right`
- آیکون‌های جهت‌دار (Chevron، Arrow) در RTL چرخانده شوند (`rtl:rotate-180`).
- فونت فارسی: `Vazirmatn` یا فونت برند؛ با `font-display: swap`.
- اعداد، تاریخ و واحد پول با Locale فارسی؛ تست ترکیب فارسی/انگلیسی.
- فرم‌ها، پیام‌های خطا و Placeholderها در RTL تست شوند.

### Audit الزامی

همه کامپوننت‌های مصرفی باید برای موارد زیر بررسی شوند:

- `text-left` / `text-right`
- `pl-*` / `pr-*` / `ml-*` / `mr-*`
- `left-*` / `right-*`
- `translate-x-*` در Switch/Slider
- Animationهای `slide-in-from-left/right`
- Iconهای جهت‌دار
- Portal و Dialog در RTL

هر Patch در `UPSTREAM.md` ثبت شود. مرجع: `https://ui.shadcn.com/docs/rtl`

## 7. ایزولاسیون در Micro-Frontend

Tailwind v4 و CSS گلوبال shadcn می‌توانند با Host تداخل کنند. برای MFE:

### 7.1 React Remote (Module Federation)

- ریشه MFE یک کلاس ثابت داشته باشد: `.idpn-root`.
- CSS خروجی MFE با یکی از روش‌های زیر محدود شود:
  - `@scope (.idpn-root) { ... }`
  - PostCSS Prefix Selector
  - CSS Layers + Selector scoping
- Preflight در MFE غیرفعال یا داخل Scope باشد.
- Radix Portalها باید `container` داخل `.idpn-root` بگیرند؛ در غیر این صورت به `body` می‌روند و استایل Host را می‌گیرند.
- Toast/Portal/Dialog/Select باید در Host با Tailwind مستقل تست شوند.

### 7.2 Web Component

- Shadow DOM برای ایزولاسیون کامل.
- CSS کامپایل‌شده داخل Shadow Root تزریق شود.
- Radix Portal `container` به یک گره داخل Shadow Root تنظیم شود.
- `:host` برای توکن‌ها و `dir`.
- تست Mount در Vue/Angular/HTML ساده.

### 7.3 Hosted Auth UI

- روی دامنه IdP اجرا می‌شود؛ تداخل Host وجود ندارد.
- با این حال از همان توکن‌ها و کامپوننت‌های Scopeشده استفاده می‌کند.
- `frame-ancestors 'none'`.

### معیار پذیرش ایزولاسیون

- [ ] Host با Tailwind مستقل، هیچ تغییر ظاهری نمی‌گیرد.
- [ ] Preflight و Reset فقط داخل ریشه MFE اثر دارد.
- [ ] Portalها داخل ریشه MFE رندر می‌شوند.
- [ ] Dark Mode Host و MFE مستقل است.
- [ ] RTL/LTR هر دو درست است.

## 8. Accessibility

- استفاده از Radix Primitiveها به‌جای HTML خام.
- Label برای همه ورودی‌ها؛ `aria-invalid` و `aria-describedby` برای خطاها.
- Focus Visible و Keyboard Navigation.
- Dialog: Focus Trap، `aria-labelledby`/`aria-describedby`، بستن با Escape.
- Select/Dropdown: کیبورد و Screen Reader.
- Touch Target حداقل 44×44 در موبایل.
- تست axe در CI؛ هیچ خطای Critical/Serious مجاز نیست.
- shadcn و Radix پایه Accessibility را می‌دهند؛ تست‌های ما منبع اعتبار نهایی هستند.

## 9. تست

| نوع | ابزار | نمونه |
|---|---|---|
| Component | Vitest + RTL | فرم ورود، Dialog، Select |
| A11y | axe-core | همه کامپوننت‌های مصرفی |
| RTL | Playwright + Screenshot | fa-IR در همه صفحات |
| Visual | Playwright Screenshot | Light/Dark و RTL/LTR |
| MFE Isolation | Playwright | Host با Tailwind مستقل |
| E2E | Playwright | ورود/SSO/مدیریت کاربر |

جزئیات در [testing.md](./testing.md).

## 10. Supply Chain

- نسخه shadcn CLI، Tailwind و Radix Pin شوند.
- `pnpm-lock.yaml` Commit شود.
- `npm audit` / `pnpm audit` در CI.
- SBOM تولید شود.
- CLI shadcn فقط در محیط توسعه/CI کنترل‌شده اجرا شود.
- وابستگی‌های Radix، `lucide-react`، `class-variance-authority` و Tailwind بررسی شوند.
- لایسنس MIT در `THIRD_PARTY_NOTICES` ثبت شود.
- به‌روزرسانی فقط با PR، Changelog، تست Regression و تأیید.

## 11. سیاست به‌روزرسانی

1. نسخه جدید shadcn/Tailwind در Branch جداگانه بررسی شود.
2. Changelog و Breaking Changes خوانده شود.
3. کامپوننت‌های Patchشده دوباره اعمال شوند.
4. تست‌های A11y/RTL/Visual اجرا شوند.
5. فقط پس از سبز شدن CI و بازبینی، Merge شود.

## 12. Skills و دستورالعمل Agent

- Skillهای موجود در [`.github/skills`](../.github/skills/README.md):
  - [accessibility-review](../.github/skills/accessibility-review/SKILL.md) برای A11y
  - [i18n-rtl-review](../.github/skills/i18n-rtl-review/SKILL.md) برای RTL و i18n
  - [playwright-skill](../.github/skills/playwright-skill/SKILL.md) برای E2E و Visual Regression
  - [dependency-review](../.github/skills/dependency-review/SKILL.md) برای Supply Chain
  - [review-gate](../.github/skills/review-gate/SKILL.md) برای پذیرش نهایی تسک
  - [code-review](../.github/skills/code-review/SKILL.md) برای بازبینی مبتنی بر شواهد
- دستورالعمل پروژه: **منبع کامپوننت shadcn/ui است؛ از کپی‌های دستی یا Registryهای تأییدنشده استفاده نشود.**
- توکن‌ها، تم و RTL مطابق همین سند پیاده‌سازی می‌شوند؛ هیچ سند دیگری مرجع جایگزین نیست.

## 13. چک‌لیست پذیرش

- [ ] نسخه shadcn CLI و Tailwind Pin شده است.
- [ ] کامپوننت‌ها در `packages/ui` و با `UPSTREAM.md` ثبت شده‌اند.
- [ ] توکن‌های `--idpn-*` تعریف و مستند شده‌اند.
- [ ] Theme هر اپ از Public Config اعمال می‌شود.
- [ ] RTL همه کامپوننت‌های مصرفی Audit و Patch شده است.
- [ ] ایزولاسیون MFE در Host با Tailwind مستقل تست شده است.
- [ ] Radix Portalها داخل ریشه MFE رندر می‌شوند.
- [ ] axe بدون خطای Critical/Serious است.
- [ ] تست Visual برای Light/Dark و RTL/LTR وجود دارد.
- [ ] Supply Chain و لایسنس بررسی شده است.
- [ ] دستورالعمل پروژه بر shadcn/ui تأکید دارد.