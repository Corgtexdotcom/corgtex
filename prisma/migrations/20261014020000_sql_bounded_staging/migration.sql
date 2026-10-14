-- Preparation streams model batches into immutable, non-serving staging. Only
-- the complete PREPARING -> PREPARED transition can seal its final output hash.
-- Existing prepared/committed receipts and their original vectors are preserved.
CREATE OR REPLACE FUNCTION pun68_sql_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-'status'-'committedAt'-'outputSetHash') IS DISTINCT FROM
    (to_jsonb(NEW)-'status'-'committedAt'-'outputSetHash')
  OR NOT ((OLD.status='PREPARING' AND NEW.status='PREPARED' AND NEW."committedAt" IS NULL
      AND ((OLD."outputSetHash"='' AND NEW."outputSetHash" ~ '^[a-f0-9]{64}$')
        OR (OLD."outputSetHash"=NEW."outputSetHash" AND NEW."outputSetHash" ~ '^[a-f0-9]{64}$')))
    OR (OLD.status='PREPARED' AND NEW.status='COMMITTED' AND NEW."committedAt" IS NOT NULL
      AND OLD."outputSetHash"=NEW."outputSetHash")) THEN
  RAISE EXCEPTION 'SQL publication set and terminal receipt are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
ALTER TABLE "SqlKnowledgePublication" ADD CONSTRAINT "pun68_sql_sealed_output_hash"
 CHECK (status='PREPARING' OR "outputSetHash" ~ '^[a-f0-9]{64}$');
