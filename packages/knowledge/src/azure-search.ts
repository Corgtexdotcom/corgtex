import { DefaultAzureCredential } from "@azure/identity";
import type { KnowledgeSourceType } from "@prisma/client";
import { env, logger } from "@corgtex/shared";
import type { SensitivityLabel } from "./sensitivity";

export type AzureKnowledgeDocument = {
  id: string;
  workspaceId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  sourceTitle: string | null;
  chunkIndex: number;
  content: string;
  contentVector: number[];
  sensitivity: SensitivityLabel;
  metadataJson: string;
  createdAt: string;
};

export type AzureKnowledgeChunkInput = {
  id: string;
  workspaceId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  sourceTitle: string | null;
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata: unknown;
  sensitivity: SensitivityLabel;
  createdAt?: Date | string | null;
};

export type AzureKnowledgeSearchResult = {
  chunkId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string | null;
  chunkIndex: number;
  snippet: string;
  score: number;
};

export type AzureKnowledgeSearchTrace = {
  provider: "azure" | "postgres";
  configuredProvider: "postgres" | "azure" | "dual_compare";
  query: string;
  rewrittenQuery?: string;
  sourceTypes?: KnowledgeSourceType[];
  hitCount: number;
  latencyMs: number;
  fallbackReason?: string;
};

type AzureSearchKeyKind = "query" | "admin";

const AZURE_SEARCH_SCOPE = "https://search.azure.com/.default";
const DEFAULT_SEMANTIC_CONFIGURATION = "knowledge-semantic";
const DEFAULT_VECTOR_PROFILE = "knowledge-vector-profile";
const DEFAULT_VECTOR_ALGORITHM = "knowledge-hnsw";
const MAX_INDEX_BATCH_SIZE = 1000;

let azureCredential: DefaultAzureCredential | null = null;

function getEndpoint() {
  return env.AZURE_SEARCH_ENDPOINT?.replace(/\/+$/, "");
}

function getIndexName() {
  return env.AZURE_SEARCH_INDEX_NAME?.trim();
}

export function getKnowledgeSearchProvider() {
  return env.KNOWLEDGE_SEARCH_PROVIDER;
}

export function isAzureKnowledgeSearchConfigured(kind: AzureSearchKeyKind = "query") {
  if (!getEndpoint() || !getIndexName()) {
    return false;
  }

  if (env.AZURE_SEARCH_AUTH_MODE === "managed_identity") {
    return true;
  }

  if (kind === "admin") {
    return Boolean(env.AZURE_SEARCH_ADMIN_KEY);
  }

  return Boolean(env.AZURE_SEARCH_QUERY_KEY || env.AZURE_SEARCH_ADMIN_KEY);
}

function requireAzureSearchConfig(kind: AzureSearchKeyKind) {
  const endpoint = getEndpoint();
  const indexName = getIndexName();
  if (!endpoint || !indexName) {
    throw new Error("Azure Search is not configured. Set AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_INDEX_NAME.");
  }

  if (env.AZURE_SEARCH_AUTH_MODE === "api_key") {
    const key = kind === "admin"
      ? env.AZURE_SEARCH_ADMIN_KEY
      : env.AZURE_SEARCH_QUERY_KEY || env.AZURE_SEARCH_ADMIN_KEY;
    if (!key) {
      throw new Error(kind === "admin"
        ? "AZURE_SEARCH_ADMIN_KEY is required for Azure Search indexing."
        : "AZURE_SEARCH_QUERY_KEY or AZURE_SEARCH_ADMIN_KEY is required for Azure Search queries.");
    }
  }

  return {
    endpoint,
    indexName,
    apiVersion: env.AZURE_SEARCH_API_VERSION,
  };
}

async function azureSearchHeaders(kind: AzureSearchKeyKind) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (env.AZURE_SEARCH_AUTH_MODE === "managed_identity") {
    azureCredential ??= new DefaultAzureCredential({
      managedIdentityClientId: env.AZURE_CLIENT_ID,
    });
    const token = await azureCredential.getToken(AZURE_SEARCH_SCOPE);
    if (!token?.token) {
      throw new Error("Unable to acquire Azure Search managed identity token.");
    }
    headers.Authorization = `Bearer ${token.token}`;
    return headers;
  }

  const key = kind === "admin"
    ? env.AZURE_SEARCH_ADMIN_KEY
    : env.AZURE_SEARCH_QUERY_KEY || env.AZURE_SEARCH_ADMIN_KEY;
  if (!key) {
    throw new Error("Azure Search API key is missing.");
  }
  headers["api-key"] = key;
  return headers;
}

async function readAzureError(response: Response) {
  const body = await response.text().catch(() => "");
  if (!body) return `${response.status} ${response.statusText}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message || parsed.message || `${response.status} ${response.statusText}`;
  } catch {
    return body.slice(0, 500);
  }
}

async function azureSearchRequest<T>(path: string, init: RequestInit, kind: AzureSearchKeyKind) {
  const { endpoint } = requireAzureSearchConfig(kind);
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      ...(await azureSearchHeaders(kind)),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Azure Search request failed: ${await readAzureError(response)}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function indexPath(suffix: string) {
  const { indexName, apiVersion } = requireAzureSearchConfig("query");
  return `/indexes('${encodeURIComponent(indexName)}')${suffix}?api-version=${encodeURIComponent(apiVersion)}`;
}

function odataString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function searchIn(field: string, values: string[]) {
  return `search.in(${field}, ${odataString(values.join(","))})`;
}

function buildFilter(params: {
  workspaceId: string;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
  sourceId?: string;
}) {
  const clauses = [`workspaceId eq ${odataString(params.workspaceId)}`];
  if (params.sourceTypes?.length) {
    clauses.push(searchIn("sourceType", params.sourceTypes));
  }
  if (params.sourceId) {
    clauses.push(`sourceId eq ${odataString(params.sourceId)}`);
  }
  if (params.maxSensitivity) {
    const sensitivityOrder: SensitivityLabel[] = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "PII"];
    const index = sensitivityOrder.indexOf(params.maxSensitivity);
    clauses.push(searchIn("sensitivity", sensitivityOrder.slice(0, Math.max(index, 0) + 1)));
  }
  return clauses.join(" and ");
}

function asSnippet(content: string) {
  return content.slice(0, 400);
}

function ensureVectorDimensions(vector: number[], id: string) {
  const dimensions = env.AZURE_SEARCH_VECTOR_DIMENSIONS;
  if (vector.length !== dimensions) {
    throw new Error(`Azure Search document ${id} has ${vector.length} embedding dimensions; expected ${dimensions}.`);
  }
}

export function buildAzureKnowledgeIndexDefinition(indexName = getIndexName()) {
  if (!indexName) {
    throw new Error("AZURE_SEARCH_INDEX_NAME is required to build the Azure Search index definition.");
  }

  return {
    name: indexName,
    fields: [
      { name: "id", type: "Edm.String", key: true, filterable: true },
      { name: "workspaceId", type: "Edm.String", filterable: true, facetable: true },
      { name: "sourceType", type: "Edm.String", filterable: true, facetable: true },
      { name: "sourceId", type: "Edm.String", filterable: true },
      { name: "sourceTitle", type: "Edm.String", searchable: true, retrievable: true },
      { name: "chunkIndex", type: "Edm.Int32", filterable: true, sortable: true },
      { name: "content", type: "Edm.String", searchable: true, retrievable: true },
      {
        name: "contentVector",
        type: "Collection(Edm.Single)",
        searchable: true,
        retrievable: false,
        dimensions: env.AZURE_SEARCH_VECTOR_DIMENSIONS,
        vectorSearchProfile: DEFAULT_VECTOR_PROFILE,
      },
      { name: "sensitivity", type: "Edm.String", filterable: true, facetable: true },
      { name: "metadataJson", type: "Edm.String", retrievable: true },
      { name: "createdAt", type: "Edm.DateTimeOffset", filterable: true, sortable: true },
    ],
    semantic: {
      defaultConfiguration: DEFAULT_SEMANTIC_CONFIGURATION,
      configurations: [
        {
          name: DEFAULT_SEMANTIC_CONFIGURATION,
          prioritizedFields: {
            titleField: { fieldName: "sourceTitle" },
            prioritizedContentFields: [{ fieldName: "content" }],
            prioritizedKeywordsFields: [
              { fieldName: "sourceType" },
              { fieldName: "sourceId" },
            ],
          },
        },
      ],
    },
    vectorSearch: {
      profiles: [
        {
          name: DEFAULT_VECTOR_PROFILE,
          algorithm: DEFAULT_VECTOR_ALGORITHM,
        },
      ],
      algorithms: [
        {
          name: DEFAULT_VECTOR_ALGORITHM,
          kind: "hnsw",
          hnswParameters: {
            metric: "cosine",
          },
        },
      ],
    },
  };
}

export async function createOrUpdateAzureKnowledgeIndex() {
  const { indexName, apiVersion } = requireAzureSearchConfig("admin");
  return azureSearchRequest<Record<string, unknown>>(
    `/indexes('${encodeURIComponent(indexName)}')?api-version=${encodeURIComponent(apiVersion)}`,
    {
      method: "PUT",
      body: JSON.stringify(buildAzureKnowledgeIndexDefinition(indexName)),
    },
    "admin",
  );
}

export function mapKnowledgeChunkToAzureDocument(chunk: AzureKnowledgeChunkInput): AzureKnowledgeDocument {
  ensureVectorDimensions(chunk.embedding, chunk.id);
  return {
    id: chunk.id,
    workspaceId: chunk.workspaceId,
    sourceType: chunk.sourceType,
    sourceId: chunk.sourceId,
    sourceTitle: chunk.sourceTitle,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    contentVector: chunk.embedding,
    sensitivity: chunk.sensitivity,
    metadataJson: JSON.stringify(chunk.metadata ?? {}),
    createdAt: chunk.createdAt ? new Date(chunk.createdAt).toISOString() : new Date().toISOString(),
  };
}

export async function uploadAzureKnowledgeDocuments(documents: AzureKnowledgeDocument[]) {
  if (documents.length === 0) {
    return { uploaded: 0 };
  }
  requireAzureSearchConfig("admin");

  let uploaded = 0;
  for (let index = 0; index < documents.length; index += MAX_INDEX_BATCH_SIZE) {
    const batch = documents.slice(index, index + MAX_INDEX_BATCH_SIZE);
    const response = await azureSearchRequest<{ value?: Array<{ key: string; status: boolean; errorMessage?: string }> }>(
      indexPath("/docs/search.index"),
      {
        method: "POST",
        body: JSON.stringify({
          value: batch.map((document) => ({
            "@search.action": "mergeOrUpload",
            ...document,
          })),
        }),
      },
      "admin",
    );
    const failed = response.value?.filter((entry) => !entry.status) ?? [];
    if (failed.length > 0) {
      throw new Error(`Azure Search failed to index ${failed.length} knowledge documents.`);
    }
    uploaded += batch.length;
  }

  return { uploaded };
}

async function listAzureKnowledgeDocumentIds(params: {
  workspaceId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
}) {
  const response = await azureSearchRequest<{ value?: Array<{ id: string }> }>(
    indexPath("/docs/search"),
    {
      method: "POST",
      body: JSON.stringify({
        search: "*",
        select: "id",
        top: MAX_INDEX_BATCH_SIZE,
        filter: buildFilter({
          workspaceId: params.workspaceId,
          sourceTypes: [params.sourceType],
          sourceId: params.sourceId,
        }),
      }),
    },
    "query",
  );

  return response.value?.map((entry) => entry.id).filter(Boolean) ?? [];
}

export async function deleteAzureKnowledgeSourceDocuments(params: {
  workspaceId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
}) {
  requireAzureSearchConfig("admin");
  let deleted = 0;

  for (;;) {
    const ids = await listAzureKnowledgeDocumentIds(params);
    if (ids.length === 0) {
      return { deleted };
    }

    const response = await azureSearchRequest<{ value?: Array<{ key: string; status: boolean; errorMessage?: string }> }>(
      indexPath("/docs/search.index"),
      {
        method: "POST",
        body: JSON.stringify({
          value: ids.map((id) => ({
            "@search.action": "delete",
            id,
          })),
        }),
      },
      "admin",
    );
    const failed = response.value?.filter((entry) => !entry.status) ?? [];
    if (failed.length > 0) {
      throw new Error(`Azure Search failed to delete ${failed.length} stale knowledge documents.`);
    }
    deleted += ids.length;
  }
}

export async function syncAzureKnowledgeSource(params: {
  workspaceId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  chunks: AzureKnowledgeChunkInput[];
}) {
  if (!isAzureKnowledgeSearchConfigured("admin")) {
    return { skipped: true, deleted: 0, uploaded: 0 };
  }

  const deleted = await deleteAzureKnowledgeSourceDocuments({
    workspaceId: params.workspaceId,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
  });
  const documents = params.chunks.map(mapKnowledgeChunkToAzureDocument);
  const uploaded = await uploadAzureKnowledgeDocuments(documents);
  return { skipped: false, deleted: deleted.deleted, uploaded: uploaded.uploaded };
}

export async function searchAzureKnowledge(params: {
  workspaceId: string;
  query: string;
  queryEmbedding: number[];
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
}) {
  requireAzureSearchConfig("query");
  ensureVectorDimensions(params.queryEmbedding, "query");

  const limit = Math.max(1, Math.min(params.limit ?? 5, 50));
  const response = await azureSearchRequest<{ value?: Array<Record<string, unknown>> }>(
    indexPath("/docs/search"),
    {
      method: "POST",
      body: JSON.stringify({
        search: params.query,
        searchFields: "sourceTitle,content",
        queryType: "semantic",
        semanticConfiguration: DEFAULT_SEMANTIC_CONFIGURATION,
        select: "id,sourceType,sourceId,sourceTitle,chunkIndex,content",
        top: limit,
        vectorFilterMode: "preFilter",
        filter: buildFilter({
          workspaceId: params.workspaceId,
          sourceTypes: params.sourceTypes,
          maxSensitivity: params.maxSensitivity,
        }),
        vectorQueries: [
          {
            kind: "vector",
            vector: params.queryEmbedding,
            fields: "contentVector",
            k: Math.max(50, limit * 5),
            weight: 1,
          },
        ],
      }),
    },
    "query",
  );

  return (response.value ?? []).map((entry) => ({
    chunkId: String(entry.id ?? ""),
    sourceType: String(entry.sourceType ?? "DOCUMENT") as KnowledgeSourceType,
    sourceId: String(entry.sourceId ?? ""),
    title: typeof entry.sourceTitle === "string" ? entry.sourceTitle : null,
    chunkIndex: Number(entry.chunkIndex ?? 0),
    snippet: asSnippet(typeof entry.content === "string" ? entry.content : ""),
    score: Number(entry["@search.rerankerScore"] ?? entry["@search.score"] ?? 0),
  })).filter((entry) => entry.chunkId && entry.sourceId);
}

export function logAzureKnowledgeIndexingWarning(error: unknown, meta: {
  workspaceId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
}) {
  logger.warn("Azure Search knowledge indexing failed", {
    workspaceId: meta.workspaceId,
    sourceType: meta.sourceType,
    sourceId: meta.sourceId,
    error: error instanceof Error ? error.message : String(error),
  });
}
