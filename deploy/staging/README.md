# Staging مشترک

این پوشه فقط سرویس‌های Stateful استیجینگ را می‌سازد: PostgreSQL، Redis و Mailpit. API و باندل MFE از Pipeline همان محیط منتشر می‌شوند و متغیرهایشان از `.env.staging` می‌آید.

```powershell
Copy-Item .env.staging.example .env.staging   # مقادیر واقعی را جای‌گذاری کنید
docker compose --env-file .env.staging -f compose.staging.yaml config --quiet
docker compose --env-file .env.staging -f compose.staging.yaml up -d
docker compose --env-file .env.staging -f compose.staging.yaml ps
```

- `.env.staging` در `.gitignore` است؛ فقط `.env.staging.example` کامیت می‌شود.
- پورت‌ها روی `127.0.0.1` منتشر می‌شوند (دسترسی از طریق Bastion/VPN).
- Mailpit: `http://127.0.0.1:8126` — برای تحویل واقعی ایمیل، `SMTP_URL` را به Relay استیجینگ تغییر دهید.
- نام پروژه، Volumeها، شبکه، پسوردها و کلیدهای رمزنگاری/امضا با Production و با محیط توسعه مشترک نیستند.

جزئیات جداسازی، چرخش Secret و Rollback: [`docs/runbooks/app-onboarding.md`](../../docs/runbooks/app-onboarding.md).
