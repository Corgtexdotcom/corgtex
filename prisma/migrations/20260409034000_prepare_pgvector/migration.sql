CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "KnowledgeChunk"
ADD COLUMN "vectorEmbedding" vector(1536);
