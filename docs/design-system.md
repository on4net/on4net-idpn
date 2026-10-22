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
2. **Semantic:** متغیرهای shadcn (`--background`, `--foreground`, `--primary`, ...) که در
   `globals.css` از لایه برند مقدار می‌گیرند: `--background: var(--idpn-background)`.
3. **Brand:** لایه `--idpn-*` که تنها لایه‌ای است که از Public Config نوشته می‌شود. مقدار
   پیش‌فرض هر توکن روی `.idpn-root` اعلام می‌شود، پس تم کلاینت همیشه بر آن اولویت دارد و
   `.idpn-root` هرگز `:root` میزبان را تغییر نمی‌دهد.

```css
/* globals.css — جهت نگاشت؛ در کد واقعی هر پالت روی .idpn-root اعلام می‌شود */
.idpn-root {
  --idpn-background: oklch(1 0 0);
  --idpn-foreground: oklch(0.145 0 0);
  --idpn-primary: oklch(0.48 0.11 190);
  --idpn-primary-foreground: oklch(0.99 0 0);
  --idpn-radius: 0.625rem;

  --background: var(--idpn-background);
  --foreground: var(--idpn-foreground);
  --primary: var(--idpn-primary);
  --primary-foreground: var(--idpn-primary-foreground);
  --radius: var(--idpn-radius);
}
```

`IdpnRoot` فقط توکن‌های `--idpn-*` را می‌نویسد (`idpnThemeToCssVariables` در
`@idpn/contracts`)، هرگز `--primary` یا سایر متغیرهای Semantic را مستقیماً.

### کلیدهای مجاز تم

| گروه | کلیدها |
| --- | --- |
| رنگ (۱۲ کلید) | `background`، `foreground`، `card`، `primary`، `primaryForeground`، `secondary`، `muted`، `accent`، `destructive`، `border`، `input`، `ring` |
| شکل | `radius` (یک طول غیرمنفی: `0`، `8px`، `0.625rem`، `50%`) |
| فونت | `fontFamily.rtl` / `fontFamily.ltr` از فهرست مجاز `vazirmatn`، `inter`، `system` |
| حالت تاریک | `dark` با همان ۱۲ کلید رنگ (`--idpn-dark-*`) |

هر کلید رنگ به `--idpn-<kebab-case>` نگاشت می‌شود (`primaryForeground` →
`--idpn-primary-foreground`) و بازنویسی تاریک به `--idpn-dark-<kebab-case>`.

### قواعد رنگ

- استفاده از رنگ‌های پیش‌فرض Tailwind (`bg-red-500`, `text-slate-500`) ممنوع است.
- فقط توکن‌های shadcn یا `--idpn-*` استفاده شود.
- **کنتراست WCAG AA (۴٫۵:۱) اجباری است.** `sanitizeIdpnTheme` جفت‌های
  `foreground`/`background` و `primaryForeground`/`primary` (و معادل‌های `dark`) را با
  `contrastRatio` می‌سنجد؛ جفتی که به ۴٫۵:۱ نرسد کنار گذاشته می‌شود و پالت داخلی
  (`IDPN_BASE_THEME`) اعمال می‌شود. پالت داخلی در هر دو حالت روشن و تاریک با تست واحد
  تأیید می‌شود.
- Dark Mode از طریق کلاس `.dark` و توکن‌های Semantic؛ بازنویسی هر کلاینت زیر `dark` می‌آید.

## 5. تم هر اپلیکیشن

- `Client.branding` در IdP شامل `logoUrl`، `title` و `theme` (ساختار ۱۲ کلید رنگ + `radius` +
  `fontFamily` + `dark`، بخش ۴) است.
- Public Config همان شیء را به MFE و Hosted UI می‌دهد؛ قرارداد آن `idpnThemeSchema` در
  `@idpn/contracts` است.
- اپ آن را با `idpnThemeToCssVariables` به CSS Variables روی ریشه خودش Map می‌کند (فقط
  `--idpn-*`)؛ هیچ کلیدی از تم به `:root` میزبان نمی‌رسد.

```ts
// همان کاری که IdpnRoot انجام می‌دهد
for (const [name, value] of Object.entries(idpnThemeToCssVariables(config.theme, { locale }))) {
  root.style.setProperty(name, value);
}
```

- Fallback امن برای همه مقادیر: مقدار نامعتبر، کلید ناشناخته یا جفت کم‌کنتراست کنار گذاشته
  می‌شود و پالت داخلی می‌ماند.
- هیچ اپی کامپوننت‌ها را Fork نمی‌کند؛ فقط Theme می‌دهد.
- تست کنتراست برای هر Theme الزامی است (تست واحد `contrastRatio` + تست axe روی تم کلاینت و
  تست Visual برای دو تم متفاوت).

### 5.1 Theme به‌ازای Login Context

- هر Context می‌تواند `branding` خودش (لوگو، عنوان، رنگ اصلی) را داشته باشد.
- ترتیب اعمال: Theme پایه اپ ← Theme همان Context.
- تغییر Context در صفحه ورود، Theme را بدون Reload عوض می‌کند.
- کنتراست برای ترکیب هر Context با هر Theme تست می‌شود (همان `sanitizeIdpnTheme` روی
  ترکیب نهایی اجرا می‌شود).

## 6. RTL و i18n

> مرجع کامل رفتار چندزبانه: [localization.md](./localization.md).

### الزامات

- `DirectionProvider` از Radix در ریشه MFE و Hosted UI.
- `dir` بر اساس Locale فعال تنظیم می‌شود (`fa-IR`/`ar-SA` → rtl، `en-US` → ltr).
- استفاده از Utilityهای Logical:
  - `ps-*` / `pe-*` به‌جای `pl-*` / `pr-*`
  - `ms-*` / `me-*` به‌جای `ml-*` / `mr-*`
  - `start-*` / `end-*` به‌جای `left-*` / `right-*`
  - `text-start` / `text-end` به‌جای `text-left` / `text-right`
- آیکون‌های جهت‌دار (Chevron، Arrow) در RTL چرخانده شوند (`rtl:rotate-180`).
- فونت به‌ازای Locale: `Vazirmatn` برای `fa-IR`، `Inter` برای `en-US`؛ با `font-display: swap`.
  - فایل‌های woff2 زیرمجموعه‌شده (OFL 1.1) در `web/public/fonts/` منتشر می‌شوند و اعلان
    `@font-face` با `unicode-range` در `web/src/styles/fonts.css` است. این فایل فقط از ورودی
    Hosted UI (`web/src/main.tsx`) بارگذاری می‌شود؛ MFE و Web Component همچنان تنها
    `globals.css` را بسته‌بندی می‌کنند تا صفحه میزبان هیچ درخواست فونتی به IdP نفرستد.
  - میزبان‌هایی که همان تایپوگرافی را در MFE می‌خواهند، همان فایل‌ها را در دامنه خود سرو
    می‌کنند (`docs/integration-guide.md`). CSP هاست‌شده `font-src 'self' data:` است.
  - تست a11y علاوه بر پشته و توکن `--idpn-font-sans`، بارگذاری واقعی فونت را با
    `document.fonts.check` و وضعیت هر Face بررسی می‌کند.
- اعداد، تاریخ و واحد پول با `Intl` و Locale فعال؛ تست ترکیب فارسی/انگلیسی.
- فرم‌ها، پیام‌های خطا و Placeholderها در RTL تست شوند.

### متن‌ها

- هیچ متن ثابتی در کامپوننت نوشته نمی‌شود؛ همه از کلیدهای بسته پایه می‌آید.
- کلیدهای پایه در `packages/i18n/messages/{locale}.json` نگهداری می‌شوند.
- Override هر اپ و هر Context فقط از API می‌آید و در زمان رندر خوانده می‌شود.
- Placeholder مجاز: `{name}`, `{appName}`, `{supportEmail}`؛ HTML مجاز نیست.
- تغییر Locale بدون Reload صفحه و بدون از دست رفتن State.

### Audit الزامی

همه کامپوننت‌های مصرفی باید برای موارد زیر بررسی شوند:

- `text-left` / `text-right`
- `pl-*` / `pr-*` / `ml-*` / `mr-*`
- `left-*` / `right-*`
- `translate-x-*` در Switch/Slider
- Animationهای `slide-in-from-left/right`
- Iconهای جهت‌دار
- Portal و Dialog در RTL
- متن Hardcoded به‌جای کلید ترجمه

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
- [ ] هیچ متن Hardcoded در کامپوننت‌ها نیست؛ همه از کلید ترجمه می‌آید.
- [ ] Locale و فونت هر اپ از Public Config اعمال می‌شود.
- [ ] Theme هر Login Context درست روی Theme اپ اعمال می‌شود.
- [ ] ایزولاسیون MFE در Host با Tailwind مستقل تست شده است.
- [ ] Radix Portalها داخل ریشه MFE رندر می‌شوند.
- [ ] axe بدون خطای Critical/Serious است.
- [ ] تست Visual برای Light/Dark و RTL/LTR وجود دارد.
- [ ] Supply Chain و لایسنس بررسی شده است.
- [ ] دستورالعمل پروژه بر shadcn/ui تأکید دارد.

## 14. تصمیم Go/No-Go: shadcn/ui در MFE (اسپایک #50)

**نتیجه: Go** برای shadcn/ui + Tailwind v4 در Hosted Auth UI، Module Federation و Web Component.
جزئیات و اندازه‌گیری‌ها: [spikes/shadcn-mfe-spike.md](./spikes/shadcn-mfe-spike.md).

| معیار | نتیجه | شاهد |
|---|---|---|
| نشت CSS/Preflight به Host | ندارد | تست Playwright با Host دارای Preflight و Utilityهای مهاجم |
| Portalهای Dialog/Select | داخل `.idpn-root` | تست E2E در Hosted، Shadow DOM و Host فدریشن |
| RTL فارسی | درست | `DirectionProvider` + Utilityهای Logical + تست axe/keyboard |
| axe | بدون Critical/Serious | سه صفحه (ورود، Host ساده، Host فدریشن) |
| React 19 Singleton | تایید شد | Mount واقعی Remote با `shared.singleton` و رندر Hook/Context |

**تصمیم‌های الزام‌آور حاصل از اسپایک:**

1. Preflight تیلویند در MFE وارد نمی‌شود؛ فقط `tailwindcss/utilities.css` ایمپورت می‌شود (`tailwindcss/theme.css` هم وارد نمی‌شود، چون `:root, :host` را به سند میزبان تزریق می‌کند).
2. توکن‌ها روی `.idpn-root` تعریف می‌شوند، نه `:root`.
3. `Dialog`/`Select` (و هر Portal آینده) مقصد Portal را خودشان از `usePortalScope()` حل می‌کنند؛
   `container` فقط برای Override صریح داده می‌شود و هرگز `null` پاس نمی‌شود
   (`resolvePortalTarget` روی `null` عمداً خطا می‌دهد — برای «هنوز آماده نیست» مقدار را حذف کنید
   تا از scope استفاده شود).
4. ماژول MFE خودکفاست (`UserManagementRoot`): ریشه، جهت و Portal Container را خودش می‌سازد،
   زیرا Context بین Bundleهای فدریشن مشترک نیست.
5. Remote روی Origin خودش سرو می‌شود یا هدر CORS دارد؛ `remoteEntry.js` بدون CORS لود نمی‌شود.
6. رنگ Primary باید کنتراست AA با متن سفید داشته باشد (`oklch(0.48 …)` یا تیره‌تر).

## 15. Governance اجرایی و زنجیره تأمین

- **منبع کامپوننت:** فقط CLI پین‌شده `pnpm dlx shadcn@4.22.0` (اسکریپت `ui:add`).
  کپی دستی یا Registry تأییدنشده ممنوع است.
- **دستورالعمل پروژه:** [`.github/instructions/ui-components.instructions.md`](../.github/instructions/ui-components.instructions.md)
  روی `web/src/components/ui/**`، `web/src/app/**` و `web/src/mfe/**` اعمال می‌شود.
- **Skill:** [`.github/skills/ui-styling/SKILL.md`](../.github/skills/ui-styling/SKILL.md) —
  روند افزودن کامپوننت، مالکیت حوزه‌ها و چک‌لیست بازبینی.
- **Inventory و Patchها:** [`web/UPSTREAM.md`](../web/UPSTREAM.md).
- **نسخه‌ها:** همه وابستگی‌های Design System دقیقاً Pin هستند (بدون `^`/`~`)؛ بررسی با `pnpm supply-chain`.
- **آسیب‌پذیری:** `pnpm audit:ci` روی High/Critical شکست می‌خورد؛ SBOM با `pnpm sbom` (CycloneDX 1.5)
  تولید می‌شود. جزئیات: [supply-chain.md](./supply-chain.md).
- **Upgrade:** فقط دستی و در PR مستقل، همراه با اعمال دوباره Patchها و اجرای
  `typecheck`، `test:coverage`، `test:e2e` و بازبینی RTL/axe.
- **لایسنس:** MIT برای shadcn/ui، Radix UI و Tailwind CSS در [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).