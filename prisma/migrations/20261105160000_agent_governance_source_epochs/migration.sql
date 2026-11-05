-- Governance snapshots share the config row's archival authority. Capture direct
-- archive/restore, deletion and tenant/key rebinding as well as archive records.
-- Policy text edits remain content changes: runtime separately fences live runs.
CREATE TRIGGER "pun80_permission_WorkspaceAgentConfig"
AFTER INSERT OR DELETE OR UPDATE ON "WorkspaceAgentConfig"
FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition(
  'WorkspaceAgentConfig', '["workspaceId","agentKey","archivedAt"]'
);
