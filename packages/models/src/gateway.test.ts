import { afterEach, describe, expect, it, vi } from "vitest";

const azureIdentityMock = vi.hoisted(() => ({
  getToken: vi.fn(),
  credentialOptions: [] as unknown[],
  DefaultAzureCredential: vi.fn(function MockDefaultAzureCredential(options: unknown) {
    azureIdentityMock.credentialOptions.push(options);
    return {
      getToken: azureIdentityMock.getToken,
    };
  }),
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: azureIdentityMock.DefaultAzureCredential,
}));

vi.mock("./usage", () => ({
  assertCatalogModelBudget: vi.fn().mockResolvedValue(undefined),
  assertWorkspaceModelBudget: vi.fn().mockResolvedValue(undefined),
  recordModelUsage: vi.fn().mockResolvedValue(undefined),
}));

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  azureIdentityMock.getToken.mockReset();
  azureIdentityMock.DefaultAzureCredential.mockClear();
  azureIdentityMock.credentialOptions.length = 0;
});

describe("fakeModelGateway", () => {
  it("supports chat, extract, embed, and rerank", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "fake",
    });

    const { fakeModelGateway } = await import("./fake-gateway");

    const chat = await fakeModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });
    const extraction = await fakeModelGateway.extract({
      workspaceId: "ws-1",
      instruction: "Summarize",
      input: "Alpha Beta",
      schemaHint: "{ summary: string }",
    });
    const embeddings = await fakeModelGateway.embed({
      workspaceId: "ws-1",
      input: ["Alpha", "Beta"],
    });
    const reranked = await fakeModelGateway.rerank({
      workspaceId: "ws-1",
      query: "alpha",
      documents: ["alpha", "zzzz unrelated"],
      topK: 1,
    });
    const transcription = await fakeModelGateway.transcribeAudio({
      workspaceId: "ws-1",
      fileName: "meeting.m4a",
      data: Buffer.from("audio"),
    });

    expect(chat.content).toContain("FAKE_MODEL_RESPONSE");
    expect(extraction.output.summary).toContain("Alpha");
    expect(embeddings.embeddings).toHaveLength(2);
    expect(reranked.results).toHaveLength(1);
    expect(reranked.results[0]?.index).toBe(0);
    expect(transcription.text).toContain("Fake transcript for meeting.m4a");
  });
});

describe("openAICompatibleModelGateway", () => {
  it("sends OpenRouter headers, provider options, and retries rate-limited chat requests", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "test-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      APP_URL: "https://corgtex.example.test",
      MODEL_CHAT_DEFAULT: "qwen/qwen3-32b",
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "Chat answer" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const chat = await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "AGENT",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(chat.content).toBe("Chat answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-key",
      "content-type": "application/json",
      "HTTP-Referer": "https://corgtex.example.test",
      "X-Title": "Corgtex",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body).toMatchObject({
      model: "qwen/qwen3-32b",
      provider: {
        allow_fallbacks: true,
        data_collection: "deny",
        require_parameters: true,
      },
    });
  });

  it("uses separate chat and embedding defaults across chat, extract, embed, and rerank", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai",
      MODEL_API_KEY: "test-key",
      MODEL_BASE_URL: "https://models.example.test/v1",
      MODEL_CHAT_DEFAULT: "gpt-test",
      MODEL_EMBEDDING_DEFAULT: "embed-test",
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "Chat answer" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "{\"summary\":\"Structured answer\"}" } }],
        usage: { prompt_tokens: 8, completion_tokens: 6 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
        usage: { prompt_tokens: 12 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ embedding: [1, 0] }, { embedding: [0.9, 0.1] }, { embedding: [0.1, 0.9] }],
        usage: { prompt_tokens: 20 },
      }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const chat = await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });
    const extraction = await openAICompatibleModelGateway.extract({
      workspaceId: "ws-1",
      instruction: "Extract summary",
      input: "Alpha Beta",
      schemaHint: "{ summary: string }",
    });
    const embeddings = await openAICompatibleModelGateway.embed({
      workspaceId: "ws-1",
      input: ["Alpha", "Beta"],
    });
    const reranked = await openAICompatibleModelGateway.rerank({
      workspaceId: "ws-1",
      query: "alpha",
      documents: ["alpha document", "unrelated"],
      topK: 1,
    });

    expect(chat.content).toBe("Chat answer");
    expect(extraction.output).toEqual({ summary: "Structured answer" });
    expect(embeddings.embeddings).toEqual([[1, 0], [0, 1]]);
    expect(reranked.results[0]?.index).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const requestBodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    expect(requestBodies.map((body) => body.model)).toEqual([
      "gpt-test",
      "gpt-test",
      "embed-test",
      "embed-test",
    ]);
    expect(requestBodies[1]).toMatchObject({
      response_format: {
        type: "json_object",
      },
    });
  });

  it("sends audio transcription requests as multipart form data", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai",
      MODEL_API_KEY: "test-key",
      MODEL_BASE_URL: "https://models.example.test/v1",
      MODEL_TRANSCRIPTION_DEFAULT: "gpt-4o-transcribe",
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      text: "Dana: We agreed on the next step.",
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const result = await openAICompatibleModelGateway.transcribeAudio({
      workspaceId: "ws-1",
      workflowJobId: "job-1",
      fileName: "meeting.m4a",
      mimeType: "audio/mp4",
      data: Buffer.from("audio"),
      prompt: "Meeting title: Team Sync",
    });

    expect(result.text).toBe("Dana: We agreed on the next step.");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    const file = form.get("file") as File;

    expect(url).toBe("https://models.example.test/v1/audio/transcriptions");
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-key",
    });
    expect(init.headers).not.toMatchObject({
      "content-type": expect.any(String),
    });
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("prompt")).toBe("Meeting title: Team Sync");
    expect(file.name).toBe("meeting.m4a");
    expect(file.type).toBe("audio/mp4");
  });

  it("sends Azure OpenAI API key headers without OpenRouter provider options", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-openai",
      MODEL_BASE_URL: "https://corgtex-openai.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "azure-key",
      MODEL_CHAT_DEFAULT: "corgtex-chat-fast",
      MODEL_PRICE_OVERRIDES_JSON: JSON.stringify([
        {
          provider: "azure-openai",
          model: "corgtex-chat-fast",
          inputUsdPerToken: 0.00000015,
          outputUsdPerToken: 0.0000006,
        },
      ]),
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Azure answer" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const chat = await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(chat.content).toBe("Azure answer");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(url).toBe("https://corgtex-openai.openai.azure.com/openai/v1/chat/completions");
    expect(init.headers).toMatchObject({
      "api-key": "azure-key",
      "content-type": "application/json",
    });
    expect(init.headers).not.toMatchObject({
      authorization: expect.any(String),
      "HTTP-Referer": expect.any(String),
      "X-Title": expect.any(String),
    });
    expect(body.provider).toBeUndefined();
    expect(chat.usage).toMatchObject({
      provider: "azure-openai",
      model: "corgtex-chat-fast",
      estimatedCostUsd: "0.000008",
    });
  });

  it("sends Azure OpenAI managed identity bearer tokens", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-openai",
      MODEL_BASE_URL: "https://corgtex-openai.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_OPENAI_SCOPE: "https://example.azure.test/.default",
      AZURE_CLIENT_ID: "user-assigned-client-id",
      MODEL_CHAT_DEFAULT: "corgtex-chat-fast",
      MODEL_PRICE_OVERRIDES_JSON: JSON.stringify([
        {
          provider: "azure-openai",
          model: "corgtex-chat-fast",
          inputUsdPerToken: 0.00000015,
          outputUsdPerToken: 0.0000006,
        },
      ]),
    });
    azureIdentityMock.getToken.mockResolvedValueOnce({
      token: "entra-token",
      expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Azure answer" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(azureIdentityMock.DefaultAzureCredential).toHaveBeenCalledTimes(1);
    expect(azureIdentityMock.credentialOptions).toContainEqual({
      managedIdentityClientId: "user-assigned-client-id",
    });
    expect(azureIdentityMock.getToken).toHaveBeenCalledWith("https://example.azure.test/.default");
    expect(init.headers).toMatchObject({
      authorization: "Bearer entra-token",
      "content-type": "application/json",
    });
    expect(init.headers).not.toMatchObject({
      "api-key": expect.any(String),
      "HTTP-Referer": expect.any(String),
      "X-Title": expect.any(String),
    });
  });

  it("blocks Azure OpenAI calls when deployment pricing is missing", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-openai",
      MODEL_BASE_URL: "https://corgtex-openai.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "azure-key",
      MODEL_CHAT_DEFAULT: "unpriced-deployment",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("Missing model price for azure-openai/unpriced-deployment");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers fenced extraction JSON without a repair pass", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai",
      MODEL_API_KEY: "test-key",
      MODEL_BASE_URL: "https://models.example.test/v1",
      MODEL_CHAT_DEFAULT: "gpt-test",
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "```json\n{\"summary\":\"Structured answer\"}\n```" } }],
      usage: { prompt_tokens: 8, completion_tokens: 6 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const extraction = await openAICompatibleModelGateway.extract({
      workspaceId: "ws-1",
      instruction: "Extract summary",
      input: "Alpha Beta",
      schemaHint: "{ summary: string }",
    });

    expect(extraction.output).toEqual({ summary: "Structured answer" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repairs malformed extraction output once", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai",
      MODEL_API_KEY: "test-key",
      MODEL_BASE_URL: "https://models.example.test/v1",
      MODEL_CHAT_DEFAULT: "gpt-test",
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "Summary: Structured answer" } }],
        usage: { prompt_tokens: 8, completion_tokens: 6 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "{\"summary\":\"Structured answer\"}" } }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const extraction = await openAICompatibleModelGateway.extract({
      workspaceId: "ws-1",
      instruction: "Extract summary",
      input: "Alpha Beta",
      schemaHint: "{ summary: string }",
    });

    expect(extraction.output).toEqual({ summary: "Structured answer" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const repairBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(String((repairBody.messages as Array<{ content: string }>)[1]?.content ?? "")).toContain("RAW_OUTPUT");
  });

  it("throws a structured error when extraction repair still fails", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai",
      MODEL_API_KEY: "test-key",
      MODEL_BASE_URL: "https://models.example.test/v1",
      MODEL_CHAT_DEFAULT: "gpt-test",
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "Summary: Structured answer" } }],
        usage: { prompt_tokens: 8, completion_tokens: 6 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "Still not JSON" } }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.extract({
      workspaceId: "ws-1",
      instruction: "Extract summary",
      input: "Alpha Beta",
      schemaHint: "{ summary: string }",
    })).rejects.toMatchObject({
      name: "ExtractionParseError",
      raw: "Summary: Structured answer",
      repairedRaw: "Still not JSON",
    });
  });
});
