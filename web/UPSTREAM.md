# UPSTREAM — shadcn/ui و کامپوننت‌های Vendored

> راهنما: هر کامپوننت shadcn که در `web/src/components/ui` نگه‌داری می‌شود باید در جدول زیر با نسخه CLI
> مبدأ، تاریخ افزودن و Patchهای محلی ثبت شود (الزام `docs/design-system.md` بخش ۳).

| مورد | مقدار |
|---|---|
| shadcn CLI | `4.22.0` — فقط با `pnpm dlx shadcn@4.22.0` (نصب‌شده نیست، بدون وابستگی Runtime) |
| تاریخ Init | 2026-10-18 |
| Style | `new-york` |
| Tailwind | v4 (بدون فایل config؛ `@tailwindcss/vite`) |
| مسیر کامپوننت‌ها | `web/src/components/ui` |
| Alias | `@/components/ui`، `@/lib/utils` |
| `components.json` | `web/components.json` |

## Inventory

| کامپوننت | مبدأ | تاریخ | Patch محلی |
|---|---|---|---|
| Button | shadcn `button` | 2026-10-18 | از پکیج یکپارچه `radix-ui` استفاده می‌کند |
| Input | shadcn `input` | 2026-10-18 | `aria-invalid:border-destructive` |
| Label | shadcn `label` | 2026-10-18 | — |
| Dialog | shadcn `dialog` | 2026-10-18 | prop `container` برای Portal داخل `.idpn-root`؛ مرکزچین با flex |
| Select | shadcn `select` | 2026-10-18 | prop `container` برای Portal |
| Form | shadcn `form` | 2026-10-18 | نسخه فشرده با `FormField/FormItem/FormLabel/FormControl/FormMessage` |
| Card | shadcn `card` | 2026-10-18 | — |
| Badge | shadcn `badge` | 2026-10-18 | Variant `outline` با توکن `border` |
| Alert | shadcn `alert` | 2026-10-18 | چیدمان RTL با `start-4` |
| Spinner | shadcn `spinner` | 2026-10-18 | SVG داخلی (بدون وابستگی آیکون) + `role="status"` |
| ScrollArea | shadcn `scroll-area` | 2026-10-18 | — |
| Tabs | shadcn `tabs` | 2026-10-18 | — |
| Table | shadcn `table` | 2026-10-18 | `text-start` به‌جای `text-left` |

## Patchهای سراسری
1. **Preflight غیرفعال است.** فقط `tailwindcss/theme.css` و `tailwindcss/utilities.css` ایمپورت می‌شوند تا CSS
   به Host نشت نکند (`docs/spikes/shadcn-mfe-spike.md`).
2. **توکن‌ها روی `.idpn-root`** تعریف می‌شوند، نه `:root`؛ بنابراین چند MFE/تم می‌توانند همزیستی کنند.
3. **همه Portalها** باید `container` داخل `.idpn-root` بگیرند (Dialog/Select).
4. به‌جای پکیج‌های جداگانه `@radix-ui/react-*` از پکیج یکپارچه `radix-ui` استفاده می‌شود.

## افزودن کامپوننت جدید

```powershell
pnpm --filter @idpn/web ui:add <component>
```

سپس: ۱) Patchهای لازم (RTL/Portal) را اعمال کنید، ۲) در جدول Inventory ثبت کنید، ۳) تست RTL/A11y اضافه کنید.

## سیاست Upgrade

1. نسخه CLI در اسکریپت `ui:add`/`ui:init` (`pnpm dlx shadcn@4.22.0`) Pin است؛ CLI در `package.json` نصب نمی‌شود و ارتقای آن فقط با تصمیم مالک Design System و در یک PR مستقل انجام می‌شود.
2. پس از ارتقا، کامپوننت‌های تغییریافته را بازتولید کنید و **Patchهای محلی را دوباره اعمال** کنید؛ سپس ردیف
   Inventory و تاریخ آن را به‌روز کنید.
3. هیچ به‌روزرسانی خودکار یا Range شناور مجاز نیست؛ Lockfile باید Commit شود.
4. پس از هر Upgrade: `typecheck`، `test:coverage`، `test:e2e` و بررسی RTL/axe الزامی است.
5. Registryهای شخص ثالث فقط با بازبینی کد و لایسنس و ثبت در همین فایل.

## منشأ کامپوننت‌های فعلی

کامپوننت‌های فهرست بالا در فاز ۰ بر اساس الگوی Registry رسمی shadcn/ui و با Patchهای محلی (RTL/Portal/توکن)
در مخزن قرار گرفته‌اند؛ اجرای `shadcn init` عمداً انجام نشد چون Preflight اضافه می‌کند و ایزولاسیون MFE را
می‌شکند. از این پس **همه** کامپوننت‌های جدید فقط با `ui:add` از Registry Pin‌شده اضافه می‌شوند؛ دستور کار در
`.github/skills/ui-styling/SKILL.md` است.

