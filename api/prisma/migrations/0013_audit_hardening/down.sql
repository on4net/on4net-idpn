DROP TRIGGER IF EXISTS "audit_events_no_truncate" ON "audit_events";

DROP INDEX IF EXISTS "audit_events_action_occurred_at_idx";

CREATE OR REPLACE FUNCTION "audit_events_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
        USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS "audit_events_append_only" ON "audit_events";

CREATE TRIGGER "audit_events_append_only"
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW
    EXECUTE FUNCTION "audit_events_append_only"();
