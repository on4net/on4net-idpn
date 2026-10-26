-- Card #81: consent. A client marked first-party (the default, so every existing tenant-registered
-- client keeps its behaviour) is never asked for consent; a client with first_party = false needs
-- a recorded approval of the requested scopes before /oauth2/authorize issues a code.
ALTER TABLE "clients" ADD COLUMN "first_party" BOOLEAN NOT NULL DEFAULT true;
