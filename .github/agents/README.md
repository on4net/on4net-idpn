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

## `idpn-reviewer`

ایجنت بازبینی. از صف **In review** برد (Project 2) پنج کارت برمی‌دارد، هر کارت را به یک Sub-Agent
مستقل می‌دهد، تست‌ها و بررسی‌های مشترک را اجرا می‌کند، برای هر کارت یک حکم مستند می‌دهد و
کارت را بر اساس حکم مسیریابی می‌کند: **`PASS` → Done**، **`FAIL` → Ready**.

**فایل:** [idpn-reviewer.agent.md](./idpn-reviewer.agent.md)

### نحوه استفاده

در Agent Picker گزینه `idpn-reviewer` را انتخاب کنید:

| درخواست | نتیجه |
|---|---|
| `صف بازبینی را انجام بده` | ۵ کارت بعدی In review → Sub-Agent برای هر کارت → تست → گزارش |
| `۵ کارت بعدی را review کن` | همان، با تأکید بر اندازه دسته |
| `#51 و #50 را review کن` | فقط همان کارت‌ها |
| `#51 را دوباره review کن` | نادیده‌گرفتن نشانه بازبینی قبلی |

### چرخه کار

```
board.ps1 inreview 5 → baseline (sha هر کارت) → 5 Sub-Agent موازی → تست‌های مشترک (سری)
→ حکم هر کارت → کامنت روی Issue → مسیریابی → دسته بعدی
```

| حکم | مسیر کارت |
|---|---|
| `PASS` | `approve` → **Done** |
| `FAIL` | `reject` → **Ready** (بازگشت به صف کار) |
| `PASS WITH WARNINGS` · `INCONCLUSIVE` | در **In review** می‌ماند (تصمیم مالک) |

مسیریابی **بعد از** ثبت کامنت شاهد انجام می‌شود؛ اگر `approve`/`reject` خطا بدهد کارت جابه‌جا نمی‌شود.

| مرحله | ابزار |
|---|---|
| یافتن کارت‌ها و Commit هر کارت | `board.ps1 inreview` + `gh issue view` + `git log --grep` |
| بازبینی هر کارت | `task` (agent_type: `general-purpose`)، حداکثر یک Sub-Agent برای هر کارت |
| Lint/Typecheck/Build/Unit/Integration/E2E/Audit | یک‌بار برای هر دسته، سری (نه موازی) |
| گزارش | `gh issue comment` با نشانه `<!-- idpn-review -->` |

### حکم‌ها

`PASS` · `PASS WITH WARNINGS` · `FAIL` · `INCONCLUSIVE` — قواعد دقیق در خود Agent آمده است.
`PASS` تنها حکمی است که به `Done` می‌رسد و باید همه مراحل `review-gate` همان کارت را پاس کند؛
یک تست سبز به‌تنهایی «پاس» نیست.

### Skillهای مورد استفاده

`code-review` · `database-review` · `dependency-review` · `performance-review` ·
`testing` · `review-gate`

## `board.ps1`

ابزار کمکی برد. خروجی فشرده می‌دهد تا Context مصرف نشود.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 counts
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 ready
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 backlog
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 inprogress
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 inreview 5
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 fill 5
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 claim 8
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 review 8
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 approve 8
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 reject 8
powershell -NoProfile -ExecutionPolicy Bypass -File .github/agents/board.ps1 set 8 -Status Ready
```

| دستور | کار |
|---|---|
| `counts` | تعداد کارت‌ها به‌ازای Status |
| `ready` | کارت‌های آماده، مرتب بر اساس فاز → اولویت → شماره |
| `backlog` | ده کارت بعدی Backlog |
| `inprogress` | کارت در دست اجرا |
| `inreview [N]` | صف In review (پیش‌فرض ۵ کارت)، مرتب بر اساس فاز → اولویت → شماره |
| `fill N` | انتقال N کارت از Backlog به Ready |
| `claim <issue>` | انتقال به In progress |
| `review <issue>` | انتقال به In review |
| `approve <issue>` | In review → **Done** (فقط برای حکم `PASS` بازبینی) |
| `reject <issue>` | In review → **Ready** (حکم `FAIL`: بازگشت به صف کار) |
| `set <issue> -Status <s>` | تغییر وضعیت دلخواه |

Epicها همیشه از `ready`/`backlog`/`fill` کنار گذاشته می‌شوند و `claim`/`approve`/`reject` روی آن‌ها خطا می‌دهد.

`approve` و `reject` هر دو کارتی را که در `In review` نیست رد می‌کنند؛ مسیر `Done` فقط از بازبینی می‌گذرد.

## نکات

- دستورهای برد نیازمند `gh` با Scope `project` هستند.
- اگر خروجی `gh` خطا داد، ابتدا `gh auth status` را بررسی کنید.
- `board.ps1` هرگز خودش تصمیم نمی‌گیرد: `approve`/`reject` فقط با حکم مستند `idpn-reviewer` اجرا می‌شوند و
  `idpn-developer` هیچ‌وقت کارتی را به `Done` نمی‌برد.
