-- Audit events are append-only (docs/security.md 10). The application has no update or
-- delete path, but the database enforces it as well so an operator mistake, a future
-- query or a leaked connection cannot rewrite history.
CREATE OR REPLACE FUNCTION "audit_events_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
        USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER "audit_events_append_only"
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW
    EXECUTE FUNCTION "audit_events_append_only"();
