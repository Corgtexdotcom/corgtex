-- Category policy changes must invalidate saved authority AND schedule derived
-- artifact rebuilding. Ignore timestamp-only updates and bump each identity once.
CREATE OR REPLACE FUNCTION pun68_information_category_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_image jsonb; after_image jsonb; identity_image jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_image := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_image := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND
    (before_image - ARRAY['id','createdAt','updatedAt']) IS NOT DISTINCT FROM
    (after_image - ARRAY['id','createdAt','updatedAt']) THEN
    RETURN NEW;
  END IF;
  FOR identity_image IN
    SELECT DISTINCT jsonb_build_object('workspaceId', value->>'workspaceId', 'category', value->>'category')
    FROM jsonb_array_elements(jsonb_build_array(before_image,after_image))
    WHERE value <> 'null'::jsonb
  LOOP
    IF EXISTS (SELECT 1 FROM "Workspace" WHERE id = identity_image->>'workspaceId') THEN
      PERFORM pun68_bump_permission_epoch(identity_image->>'workspaceId','InformationCategoryPolicy',identity_image->>'category');
      PERFORM pun68_emit_permission_rebuild(identity_image->>'workspaceId','InformationCategoryPolicy',identity_image->>'category');
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
