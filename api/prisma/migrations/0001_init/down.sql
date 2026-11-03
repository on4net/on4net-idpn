-- Down migration for 0001_init.
-- Drops every object created by migration.sql, in reverse dependency order.

DROP TABLE IF EXISTS "refresh_tokens" CASCADE;
DROP TABLE IF EXISTS "authorization_codes" CASCADE;
DROP TABLE IF EXISTS "consents" CASCADE;
DROP TABLE IF EXISTS "audit_events" CASCADE;
DROP TABLE IF EXISTS "role_permissions" CASCADE;
DROP TABLE IF EXISTS "assignments" CASCADE;
DROP TABLE IF EXISTS "client_memberships" CASCADE;
DROP TABLE IF EXISTS "client_login_contexts" CASCADE;
DROP TABLE IF EXISTS "client_social_providers" CASCADE;
DROP TABLE IF EXISTS "client_secrets" CASCADE;
DROP TABLE IF EXISTS "sessions" CASCADE;
DROP TABLE IF EXISTS "permissions" CASCADE;
DROP TABLE IF EXISTS "roles" CASCADE;
DROP TABLE IF EXISTS "identities" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;
DROP TABLE IF EXISTS "clients" CASCADE;
DROP TABLE IF EXISTS "tenants" CASCADE;
DROP TABLE IF EXISTS "signing_keys" CASCADE;

DROP TYPE IF EXISTS "SigningKeyStatus";
DROP TYPE IF EXISTS "SigningKeyAlg";
DROP TYPE IF EXISTS "AuditResult";
DROP TYPE IF EXISTS "AuditActorType";
DROP TYPE IF EXISTS "AssignmentScopeType";
DROP TYPE IF EXISTS "AssignmentSubjectType";
DROP TYPE IF EXISTS "MembershipStatus";
DROP TYPE IF EXISTS "LoginContextStatus";
DROP TYPE IF EXISTS "MfaPolicy";
DROP TYPE IF EXISTS "RegistrationPolicy";
DROP TYPE IF EXISTS "ClientStatus";
DROP TYPE IF EXISTS "ClientType";
DROP TYPE IF EXISTS "SocialProvider";
DROP TYPE IF EXISTS "IdentityProvider";
DROP TYPE IF EXISTS "UserStatus";
DROP TYPE IF EXISTS "TenantStatus";
