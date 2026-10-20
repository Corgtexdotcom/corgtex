-- Rebuild consumers use the workspace/event identity, never the governor list.
-- Keep one durable event per transaction without copying an ever-growing JSON
-- array for each before/after row image. Epoch updates remain in their existing
-- triggers and roll back atomically with this event. Historical v1 events are
-- deliberately untouched and remain readable by the same rebuild planner.
CREATE OR REPLACE FUNCTION pun68_emit_permission_rebuild(workspace_id text, governor_kind text, source_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM "Workspace" WHERE id = workspace_id) THEN RETURN; END IF;
  INSERT INTO "Event" (id,"workspaceId",type,"aggregateType","aggregateId",payload,status,"availableAt","createdAt")
  VALUES (md5('pun68-permission:' || workspace_id || ':' || txid_current()::text),workspace_id,
    'source-permission.changed','SourcePermissionEpoch',workspace_id,
    jsonb_build_object('version',2,'scope','WORKSPACE'),
    'PENDING',now(),now())
  ON CONFLICT (id) DO NOTHING;
END;
$$;
