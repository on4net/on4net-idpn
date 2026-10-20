# زنجیره تأمین Design System

> مرجع: [design-system.md](./design-system.md) (بخش ۱۰ و ۱۱) و [security.md](./security.md).
> این سند نتیجه بررسی زنجیره تأمین کارت #57 است.

## 1. نسخه‌های Pin‌شده

هیچ وابستگی Design System با Range شناور نصب نمی‌شود. ابزار بررسی:

```powershell
pnpm supply-chain   # node tools/check-supply-chain.mjs --licenses
```

| پکیج | نقش | نسخه دقیق |
|---|---|---|
| `react` / `react-dom` | UI runtime (Singleton در MFE) | `19.3.1` |
| `radix-ui` | Primitiveهای A11y (پکیج یکپارچه) | `1.8.1` |
| `tailwindcss` / `@tailwindcss/vite` | Styling | `4.3.3` |
| `class-variance-authority` | Variant API | `0.7.1` |
| `clsx` / `tailwind-merge` | `cn()` | `2.1.1` / `3.7.0` |
| `react-hook-form` / `@hookform/resolvers` | Forms | `7.90.0` / `5.9.2` |
| `zod` | Schema مشترک | `4.6.7` |
| `vite` / `@vitejs/plugin-react` | Build | `8.3.4` / `6.1.2` |
| `@module-federation/vite` | MFE Remote/Host | `1.23.5` |
| `shadcn` (CLI) | فقط `pnpm dlx shadcn@4.22.0` — **نصب‌شده نیست** | `4.22.0` |

`check-supply-chain.mjs` در صورت Range شناور، اختلاف نسخه React بین پکیج‌ها، یا لایسنس خارج از فهرست مجاز،
با خروجی غیرصفر متوقف می‌شود.

## 2. نتیجه `pnpm audit`

```
pnpm audit --audit-level=high   →  No known vulnerabilities found
```

### یافته و رفع

| مورد | جزئیات |
|---|---|
| یافته | `braces@3.0.3` — ReDoS با الگوهای عمیقاً تودرتو (GHSA-vfj7-8cjw-p6xm، severity **high**) |
| مسیر | `web > shadcn@4.22.0 > fast-glob/ts-morph > micromatch > braces` |
| چرا High بود | فقط از طریق CLI طراحی وارد درخت می‌شد، اما در `pnpm audit` به‌عنوان آسیب‌پذیری پروژه دیده می‌شد |
| رفع | وابستگی `shadcn` از `package.json` **حذف** شد؛ CLI فقط با `pnpm dlx shadcn@4.22.0` روی تقاضا اجرا می‌شود |
| تأیید | `pnpm audit --audit-level=high` → `No known vulnerabilities found` |

اجرای CLI روی تقاضا، سطح حمله نصب را کوچک می‌کند و نسخه همچنان Pin است. `dlx` هیچ وابستگی Runtime به اپ اضافه نمی‌کند.

## 3. SBOM

```powershell
pnpm sbom            # artifacts/sbom.cdx.json (CycloneDX 1.5)
```

- ورودی: `pnpm-lock.yaml` (همه نسخه‌ها + `integrity` به‌صورت SHA-512) و `pnpm licenses list --json` (لایسنس).
- خروجی: یک Component برای هر `name@version` با `purl` (`pkg:npm/...`)، هش و لایسنس؛ به‌صورت الفبایی مرتب.
- `artifacts/` در Git نیست؛ در CI به‌صورت Artifact آپلود می‌شود.
- تعداد Component در آخرین اجرا (Release Gate #49، HEAD `a1a47da`): **820**.

## 4. لایسنس‌ها

- فهرست مجاز (allowlist) در `tools/check-supply-chain.mjs`: MIT، ISC، Apache-2.0، BSD-2/3-Clause، 0BSD،
  CC0-1.0، MIT-0، Unlicense، Python-2.0.
- لایسنس‌های Design System (shadcn/ui، Radix UI، Tailwind CSS) در [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)
  ثبت شده‌اند.
- هر لایسنس خارج از allowlist باعث شکست بررسی می‌شود و نیاز به تصمیم حقوقی/مالک دارد.

## 5. بررسی CLI

| موضوع | نتیجه |
|---|---|
| نصب | نصب نیست؛ `pnpm dlx shadcn@4.22.0` با نسخه Pin |
| دسترسی شبکه | فقط هنگام افزودن کامپوننت جدید (اجرای دستی توسط توسعه‌دهنده) |
| اجرا در CI/Build | هرگز — هیچ اسکریپت CI آن را صدا نمی‌زند |
| اثر روی محصول | فقط Source کامپوننت‌ها را در مخزن می‌نویسد؛ در Runtime استفاده نمی‌شود |

## 6. سیاست Upgrade

1. ارتقا فقط **دستی** و در PR مستقل، با تصمیم مالک Design System.
2. پس از ارتقا: `pnpm install` → `pnpm supply-chain` → `pnpm audit:ci` → `pnpm test:unit` → `pnpm test:e2e`.
3. Patchهای محلی (Preflight غیرفعال، توکن روی `.idpn-root`، Portal Container) باید دوباره اعمال و در
   `web/UPSTREAM.md` ثبت شوند.
4. Lockfile همیشه Commit می‌شود؛ `pnpm install --frozen-lockfile` در CI اجرا می‌شود.
5. هیچ به‌روزرسانی خودکار (Dependabot/Renovate برای این پکیج‌ها) فعال نیست.

## 7. هشدار نسخه ناسازگار

`tools/check-supply-chain.mjs` این موارد را به‌عنوان خطا گزارش می‌کند:

- Range شناور (`^`, `~`, `latest`, `*`) روی پکیج‌های فهرست Pin.
- اختلاف نسخه `react`/`react-dom` بین `api`، `web`، `packages/*` و ریشه (شکستن Singleton در MFE).
- لایسنس خارج از allowlist.

در CI، Job `supply-chain` این اسکریپت، `pnpm audit --audit-level=high` و تولید SBOM را اجرا می‌کند.
