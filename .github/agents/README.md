# Agents — on4net IDPN

## `idpn-developer`

Agent پیاده‌سازی پروژه. از Project 2 کار برمی‌دارد، با Skillها اجرا می‌کند و کارت را به **In review** می‌برد.

**فایل:** [idpn-developer.agent.md](./idpn-developer.agent.md)

### نحوه استفاده

در Agent Picker گزینه `idpn-developer` را انتخاب کنید و یکی از این‌ها را بخواهید:

| درخواست | نتیجه |
|---|---|
| `برد را انجام بده` | حلقه کامل: Ready → In progress → پیاده‌سازی → In review |
| `تسک #10 را انجام بده` | فقط همان کارت |
| `فاز ۰ را ادامه بده` | کارت‌های همان فاز به‌ترتیب اولویت |
| `وضعیت برد` | فقط گزارش `counts` و کارت‌های جاری |

### چرخه کار

```
backlog → ready → in progress → [پیاده‌سازی + تست + گزارش] → in review → (مالک) → done
```

- فقط **یک** کارت در In progress.
- `Ready` خالی → `fill 5` از Backlog.
- `Done` فقط توسط مالک پروژه و بعد از `review-gate`.

### Skillهای مورد استفاده

`senior-developer` · `github-task-management` · `board-loop` · `testing` · `debugging` ·
`accessibility-review` · `i18n-rtl-review` · `api-contract-review` · `database-review` ·
`dependency-review` · `performance-review` · `playwright-skill` · `security-review` ·
`code-cleanup` · `review-gate` · `git-workflow`

## `board.ps1`

ابزار کمکی برد. خروجی فشرده می‌دهد تا Context مصرف نشود.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 counts
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 ready
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 backlog
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 inprogress
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 fill 5
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 claim 8
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 review 8
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 set 8 -Status Ready
```

| دستور | کار |
|---|---|
| `counts` | تعداد کارت‌ها به‌ازای Status |
| `ready` | کارت‌های آماده، مرتب بر اساس فاز → اولویت → شماره |
| `backlog` | ده کارت بعدی Backlog |
| `inprogress` | کارت در دست اجرا |
| `fill N` | انتقال N کارت از Backlog به Ready |
| `claim <issue>` | انتقال به In progress |
| `review <issue>` | انتقال به In review |
| `set <issue> -Status <s>` | تغییر وضعیت دلخواه |

Epicها همیشه از `ready`/`backlog`/`fill` کنار گذاشته می‌شوند و `claim` روی آن‌ها خطا می‌دهد.

## نکات

- دستورهای برد نیازمند `gh` با Scope `project` هستند.
- اگر خروجی `gh` خطا داد، ابتدا `gh auth status` را بررسی کنید.
- `board.ps1` هیچ‌وقت کارتی را به `Done` نمی‌برد.
