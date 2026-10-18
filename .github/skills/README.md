# Skills — on4net IDPN

مجموعه Skillهای پروژه **on4net IDPN** (سامانه هویت و دسترسی مرکزی). هیچ Skill این پوشه به پروژه دیگری وابسته نیست.

## منبع حقیقت پروژه

پیش از اجرای هر Skill، اسناد پروژه اولویت دارند:

- [docs/README.md](../../docs/README.md)
- [docs/architecture.md](../../docs/architecture.md)
- [docs/domain-model.md](../../docs/domain-model.md)
- [docs/auth-flows.md](../../docs/auth-flows.md)
- [docs/api.md](../../docs/api.md)
- [docs/micro-frontend.md](../../docs/micro-frontend.md)
- [docs/design-system.md](../../docs/design-system.md) — **shadcn/ui**
- [docs/security.md](../../docs/security.md)
- [docs/testing.md](../../docs/testing.md)
- [docs/integration-guide.md](../../docs/integration-guide.md)
- [docs/roadmap.md](../../docs/roadmap.md)

## Skillهای پروژه

| Skill | کاربرد |
|---|---|
| `github-task-management` | ثبت و تریاژ تسک در `on4net/on4net-idpn` و Project 2 |
| `board-loop` | کار کردن Board از Ready تا خالی‌شدن (Project 2) |
| `git-workflow` | Git workflow روی مخزن `on4net/on4net-idpn` |
| `testing` | Unit/Integration/E2E برای `api/`، `web/` و MFE |
| `accessibility-review` | A11y برای Hosted Auth UI و MFE |
| `i18n-rtl-review` | RTL فارسی/انگلیسی، تاریخ، اعداد و ترجمه |
| `performance-review` | کارایی API، React، MFE، Query و Cache |
| `database-review` | PostgreSQL، Migration، Index و Query |
| `api-contract-review` | OIDC/Admin API و مصرف‌کننده‌ها (Web/MFE/BFF) |
| `review-gate` | Definition of Done و چک‌لیست قبل از Done |
| `documentation-audit` | Audit `docs/`، لینک‌ها، تناقض‌ها و Drift |
| `dependency-review` | وابستگی‌های `api/`، `web/` و `packages/` |
| `code-cleanup` | پاک‌سازی امن کد بدون تغییر رفتار |
| `debugging` | ریشه‌یابی باگ در API/Web/MFE |
| `code-review` | بازبینی مبتنی بر شواهد: باگ، امنیت، تست، معماری |
| `senior-developer` | چارچوب اجرای مهندسی برای طراحی، پیاده‌سازی و تحویل |
| `security-review` | اسکن و بازبینی امنیتی |
| `sql-code-review` | بازبینی SQL (Injection، Performance، Anti-pattern) |
| `quality-playbook` | Audit کیفیت کامل با Spec Traceability |
| `playwright-skill` | E2E، Cross-browser، Visual Regression |

## نکات محیط

- سیستم‌عامل توسعه: Windows؛ در دستورهای Python از `python` استفاده می‌شود.
- Backend: Node.js LTS + TypeScript + NestJS (Fastify) در `api/`.
- Database: PostgreSQL 16؛ Cache/Session: Redis 7.
- Frontend: React 19 + Vite در `web/`؛ Design System: **shadcn/ui** (CLI `4.22.0`) + Tailwind CSS v4 + Radix UI.
- MFE: Module Federation برای Hostهای React و Web Component برای سایر فریمورک‌ها.
- فازها: `phase:0` … `phase:6`؛ اولویت‌ها: `P0`، `P1`، `P2`.

## قواعد استفاده

1. قبل از تغییر کد، `git status` و `git diff` را بررسی کنید.
2. برای هر تغییر، تست مربوطه را در `docs/testing.md` پیدا و اجرا کنید.
3. برای UI و کامپوننت‌ها، `docs/design-system.md` (shadcn/ui + Tailwind v4) مبنا است.
4. برای RTL، `i18n-rtl-review` را روی کامپوننت‌های shadcn اجرا کنید.
5. برای تسک جدید، `github-task-management` را دنبال کنید و Epic/Phase را مشخص کنید.
6. قبل از Done، `review-gate` را اجرا کنید.