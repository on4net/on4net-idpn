-- Audit trail hardening (docs/security.md 10, finding 1 and 2 of the review).
--
-- 1. TRUNCATE was not blocked: the row-level trigger never fires for it, so the whole log
--    could be wiped in one statement. A statement-level trigger closes that.
-- 2. There was no maintenance path at all, so the documented 12-month retention and the
--    anonymisation on account deletion could only be done by disabling the control. The
--    trigger now allows DELETE/TRUNCATE only while the session-local switch
--    `idpn.audit_maintenance` is `on` (see api/scripts/ops/audit-retention.ts). UPDATE stays
--    forbidden even then: history may be pruned, never rewritten.
-- 3. `action` filters had no supporting index.
--
-- The privilege split (append-only writer role vs. a NOLOGIN owner) is an operator step
-- documented in docs/security.md 10; it needs credentials this migration must not create.

CREATE OR REPLACE FUNCTION "audit_events_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('idpn.audit_maintenance', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        IF TG_OP = 'TRUNCATE' THEN
            RETURN NULL;
        END IF;
        RAISE EXCEPTION 'audit_events rows are immutable: % is not allowed even in maintenance', TG_OP
            USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
        USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS "audit_events_append_only" ON "audit_events";

CREATE TRIGGER "audit_events_append_only"
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW
    EXECUTE FUNCTION "audit_events_append_only"();

DROP TRIGGER IF EXISTS "audit_events_no_truncate" ON "audit_events";

CREATE TRIGGER "audit_events_no_truncate"
    BEFORE TRUNCATE ON "audit_events"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "audit_events_append_only"();

-- CreateIndex
CREATE INDEX "audit_events_action_occurred_at_idx" ON "audit_events"("action", "occurred_at");
