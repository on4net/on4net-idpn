---
name: database-review
description: 'Review the on4net IDPN database: schema, migrations, queries, indexes, constraints, data integrity, and migration safety. Use when checking a schema change, reviewing a migration, auditing queries for performance/correctness, or verifying constraints and indexes. Load the sql-code-review skill for deep SQL-level review.'
argument-hint: 'Database area to review: schema, migration, query, or index...'
---

# on4net IDPN Database Review

Review the on4net IDPN database design and changes for correctness, safety, and integrity.

## Context
- Databases: PostgreSQL 16 (identity, clients, memberships, roles, sessions, audit) and Redis 7 (sessions, rate limit, cache/queue).
- Migrations: Prisma migrations under `api/prisma/migrations/` (or the configured migration directory); source of truth for schema: `docs/domain-model.md`.
- Code: NestJS + TypeScript, Prisma (or Drizzle), Zod/class-validator.

## When to Use
- A schema change or migration is proposed.
- The user asks to review tables, indexes, constraints, queries, or data integrity.
- You need to verify a migration is safe before it runs.

## Check Categories
- **Schema** — tables, columns, types, relationships (FKs), and defaults match `docs/domain-model.md` and the application schemas.
- **Migrations** — each SQL migration is ordered, idempotent where appropriate, and does not lose data unexpectedly; naming convention `NNNN_<name>.sql`.
- **Migration safety** — destructive operations (drop column/table, type change, non-nullable add) flagged; backfill/rollback considered.
- **Queries** — N+1 problems, missing filters, unindexed lookups, SELECT * where narrow is better.
- **Indexes** — indexes exist for frequently queried/filtered/joined columns (especially `client_id`, `user_id`, `session_id`, `tenant_id` and time-range columns on audit/session tables); no redundant indexes.
- **Constraints** — PKs, FKs, uniques, checks, and not-null enforce data integrity.
- **Data integrity** — orphaned rows, inconsistent states, missing ON DELETE behavior.

## Procedure
1. Identify the schema/migration/query in scope.
2. Read the migration SQL/Prisma file(s) in `api/prisma/migrations/` and the related schema/models.
3. Review queries that touch the affected tables (in `api/src/`).
4. For deep SQL-level review (injection, performance, anti-patterns), load the `sql-code-review` skill (`.github/skills/sql-code-review/SKILL.md`).
5. Report findings with severity and file/line references.

## Output Format
- Scope reviewed
- Findings by severity (schema / migration / query / index / constraint / integrity)
- Migration safety assessment
- Recommended changes
