# نمونه‌های Onboarding

همهٔ مقادیر این پوشه **ساختگی** هستند و هیچ Credential واقعی در آن نیست.

| فایل                   | کاربرد                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| `platform-a.json`      | سند کامل اپ نمونه: Provider سوشال، کاتالوگ مجوز و نقش‌ها           |
| `platform-b.json`      | اپ دوم برای بررسی جداسازی Credential/نقش‌ها                        |
| `secrets.example.json` | قالب فایل Secret؛ آن را به `*.secrets.json` کپی کنید (git-ignored) |
| `users.csv`            | نمونهٔ مهاجرت با `roleKeys` و `memberships` چند اپی                |
| `users.json`           | همان داده به شکل JSON با `memberships` به‌صورت Map                 |

```powershell
# اعتبارسنجی سند و برنامهٔ نگاشت
pnpm --filter @idpn/api run onboard:client -- apply `
  --config examples/onboarding/platform-a.json --skip-social --dry-run

# اعتبارسنجی فایل کاربران
pnpm --filter @idpn/api run import:users -- import `
  --client platform-a --file examples/onboarding/users.csv `
  --actor admin@example.com --dry-run
```

مرجع کامل: [`docs/app-onboarding.md`](../../docs/app-onboarding.md) و [Runbook](../../docs/runbooks/app-onboarding.md).
