ALTER TABLE "BrainSource" ADD COLUMN "informationCategory" TEXT NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "Document" ADD COLUMN "informationCategory" TEXT NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "Meeting" ADD COLUMN "informationCategory" TEXT NOT NULL DEFAULT 'GENERAL';
DROP TRIGGER "pun68_permission_BrainSource" ON "BrainSource";
CREATE TRIGGER "pun68_permission_BrainSource" AFTER INSERT OR DELETE OR UPDATE ON "BrainSource" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('BrainSource', '["accessDomain","archivedAt","authorMemberId","metadata","sourceType","workspaceId","informationCategory"]');
DROP TRIGGER "pun68_permission_Document" ON "Document";
CREATE TRIGGER "pun68_permission_Document" AFTER INSERT OR DELETE OR UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Document', '["accessDomain","archivedAt","workspaceId","informationCategory"]');
DROP TRIGGER "pun68_permission_Meeting" ON "Meeting";
CREATE TRIGGER "pun68_permission_Meeting" AFTER INSERT OR DELETE OR UPDATE ON "Meeting" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('Meeting', '["archivedAt","workspaceId","informationCategory"]');
-- A chosen export is immutable native authority; edit/revoke by retiring its output.
CREATE FUNCTION pun68_brain_consent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation = 'BRAIN_EXPORT_CONSENT' OR NEW.operation = 'BRAIN_EXPORT_CONSENT' THEN
    RAISE EXCEPTION 'Immutable Brain export consent cannot be updated';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "pun68_brain_consent_immutable" BEFORE UPDATE ON "ConversationOperationOutcome"
  FOR EACH ROW EXECUTE FUNCTION pun68_brain_consent_immutable();
