-- Current recovery consent is an immutable operational fact, never a fabricated
-- historical human-original receipt. Existing outcome epoch tombstones fence deletion.
CREATE FUNCTION pun68_legacy_recovery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation = 'LEGACY_RECOVERY_PUBLICATION' OR NEW.operation = 'LEGACY_RECOVERY_PUBLICATION' THEN
    RAISE EXCEPTION 'Immutable legacy recovery consent cannot be updated';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "pun68_legacy_recovery_immutable" BEFORE UPDATE ON "ConversationOperationOutcome"
  FOR EACH ROW EXECUTE FUNCTION pun68_legacy_recovery_immutable();
