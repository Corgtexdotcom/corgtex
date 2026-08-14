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

    const stream = fakeModelGateway.chatEventStream({
      workspaceId: "ws-1", taskType: "CHAT", messages: [{ role: "user", content: "Hello" }],
    });
    expect(await stream.next()).toMatchObject({ value: { type: "content_delta" } });
    await stream.return(undefined as never);
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

  it("keeps the non-stream request signal active while decoding JSON", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai",
      MODEL_API_KEY: "test-key",
      MODEL_BASE_URL: "https://api.openai.com/v1",
      MODEL_CHAT_DEFAULT: "gpt-test",
    });

    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let jsonStarted = false;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      providerSignal = init?.signal as AbortSignal | undefined;
      return {
        ok: true,
        json: () => {
          jsonStarted = true;
          return new Promise((resolve, reject) => {
            providerSignal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            }, { once: true });
          });
        },
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const request = openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(providerSignal).toBeDefined();
      expect(jsonStarted).toBe(true);
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
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

  it("sends Azure Foundry API key headers through the OpenAI-compatible v1 endpoint", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://corgtex-foundry.services.ai.azure.com/openai/v1/",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "foundry-key",
      MODEL_CHAT_DEFAULT: "corgtex-ds-v4-flash",
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Foundry answer" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const chat = await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(url).toBe("https://corgtex-foundry.services.ai.azure.com/openai/v1/chat/completions");
    expect(init.headers).toMatchObject({
      "api-key": "foundry-key",
      "content-type": "application/json",
    });
    expect(init.headers).not.toMatchObject({
      authorization: expect.any(String),
      "HTTP-Referer": expect.any(String),
      "X-Title": expect.any(String),
    });
    expect(body).toMatchObject({
      model: "corgtex-ds-v4-flash",
    });
    expect(body.provider).toBeUndefined();
    expect(chat.usage).toMatchObject({
      provider: "azure-foundry",
      model: "corgtex-ds-v4-flash",
      rawProviderCostUsd: "0.000445",
      estimatedCostUsd: "0.000890",
    });
  });

  it("uses the Foundry Entra scope by default for Azure Foundry managed identity", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      MODEL_CHAT_DEFAULT: "corgtex-kimi-k25",
    });
    azureIdentityMock.getToken.mockResolvedValueOnce({
      token: "foundry-entra-token",
      expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Foundry answer" } }],
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

    expect(azureIdentityMock.getToken).toHaveBeenCalledWith("https://ai.azure.com/.default");
    expect(init.headers).toMatchObject({
      authorization: "Bearer foundry-entra-token",
      "content-type": "application/json",
    });
  });

  it("routes a configured model alias to Azure Foundry while the global provider remains OpenRouter", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      APP_URL: "https://corgtex.example.test",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-gpt56-luna",
          provider: "azure-foundry",
          baseUrl: "https://corgtex-foundry.services.ai.azure.com/openai/v1/",
          authMode: "managed_identity",
          scope: "https://ai.azure.com/.default",
        },
      ]),
    });
    azureIdentityMock.getToken.mockResolvedValueOnce({
      token: "foundry-route-token",
      expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Routed Foundry answer" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const chat = await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "corgtex-gpt56-luna",
      messages: [{ role: "user", content: "Hello" }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(url).toBe("https://corgtex-foundry.services.ai.azure.com/openai/v1/chat/completions");
    expect(azureIdentityMock.getToken).toHaveBeenCalledWith("https://ai.azure.com/.default");
    expect(init.headers).toMatchObject({
      authorization: "Bearer foundry-route-token",
      "content-type": "application/json",
    });
    expect(init.headers).not.toMatchObject({
      "api-key": expect.any(String),
      "HTTP-Referer": expect.any(String),
      "X-Title": expect.any(String),
    });
    expect(body).toMatchObject({
      model: "corgtex-gpt56-luna",
    });
    expect(body.temperature).toBeUndefined();
    expect(body.provider).toBeUndefined();
    expect(chat.usage).toMatchObject({
      provider: "azure-foundry",
      model: "corgtex-gpt56-luna",
      rawProviderCostUsd: "0.004000",
      estimatedCostUsd: "0.008000",
    });
  });

  it("inherits the configured Azure scope for same-provider routes without a route scope", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://global-foundry.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "managed_identity",
      AZURE_OPENAI_SCOPE: "api://custom-foundry-scope/.default",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-gpt56-luna",
          provider: "azure-foundry",
          baseUrl: "https://corgtex-foundry.services.ai.azure.com/openai/v1/",
          authMode: "managed_identity",
        },
      ]),
    });
    azureIdentityMock.getToken.mockResolvedValueOnce({
      token: "same-provider-token",
      expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Routed Foundry answer" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "corgtex-gpt56-luna",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(azureIdentityMock.getToken).toHaveBeenCalledWith("api://custom-foundry-scope/.default");
  });

  it("rejects managed identity routes to non-Azure endpoints before acquiring a token", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-gpt56-luna",
          provider: "azure-foundry",
          baseUrl: "https://attacker.example/v1",
          authMode: "managed_identity",
        },
      ]),
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "corgtex-gpt56-luna",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("azure-foundry managed identity authentication requires a trusted Azure OpenAI-compatible /openai/v1 base URL");
    expect(azureIdentityMock.getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fall back to the global Azure key when a routed Azure key env is missing", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      AZURE_OPENAI_API_KEY: "global-azure-key",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-ds-v4-flash",
          provider: "azure-foundry",
          baseUrl: "https://corgtex-foundry.services.ai.azure.com/openai/v1/",
          authMode: "api_key",
          apiKeyEnv: "FOUNDRY_ROUTE_KEY",
        },
      ]),
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "corgtex-ds-v4-flash",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("FOUNDRY_ROUTE_KEY is required for routed Azure API key authentication");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an explicit key env when an Azure API-key route targets a routed endpoint", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-openai",
      MODEL_BASE_URL: "https://global-openai.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "global-azure-key",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-gpt56-luna",
          provider: "azure-foundry",
          baseUrl: "https://corgtex-foundry.services.ai.azure.com/openai/v1/",
          authMode: "api_key",
        },
      ]),
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "corgtex-gpt56-luna",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_PROVIDER_ROUTES_JSON route for corgtex-gpt56-luna requires apiKeyEnv when using Azure API key authentication with a routed endpoint");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves MODEL_API_KEY fallback for same-provider Azure routes that inherit the global endpoint", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-openai",
      MODEL_BASE_URL: "https://global-openai.openai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "",
      MODEL_API_KEY: "model-key",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-ds-v4-flash",
          provider: "azure-openai",
        },
      ]),
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Inherited route answer" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const chat = await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "corgtex-ds-v4-flash",
      messages: [{ role: "user", content: "Hello" }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://global-openai.openai.azure.com/openai/v1/chat/completions");
    expect(init.headers).toMatchObject({
      "api-key": "model-key",
      "content-type": "application/json",
    });
    expect(chat.usage).toMatchObject({
      provider: "azure-openai",
      model: "corgtex-ds-v4-flash",
    });
  });

  it("does not fall back to MODEL_API_KEY when a routed OpenRouter key env is missing", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
      MODEL_API_KEY: "global-openrouter-key",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "deepseek/deepseek-v4-pro",
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_ROUTE_KEY",
        },
      ]),
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("OPENROUTER_ROUTE_KEY is required for routed OpenAI-compatible provider authentication");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate per-model provider routes", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "gpt-4o",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_ROUTE_KEY",
        },
        {
          model: "gpt-4o",
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      ]),
      OPENAI_ROUTE_KEY: "openai-key",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_PROVIDER_ROUTES_JSON contains duplicate route for gpt-4o");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects plaintext per-model provider route URLs at runtime", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "deepseek/deepseek-v4-pro",
          provider: "openrouter",
          baseUrl: "http://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_ROUTE_KEY",
        },
      ]),
      OPENROUTER_ROUTE_KEY: "route-key",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_PROVIDER_ROUTES_JSON[0].baseUrl must be an HTTPS URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.openai.com/v1?api-version=bad",
    "https://api.openai.com/v1#fragment",
  ])("rejects query or fragment components in per-model provider route URLs: %s", async (routeBaseUrl) => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "gpt-4o",
          provider: "openai",
          baseUrl: routeBaseUrl,
          apiKeyEnv: "OPENAI_ROUTE_KEY",
        },
      ]),
      OPENAI_ROUTE_KEY: "route-key",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_PROVIDER_ROUTES_JSON[0].baseUrl must be an HTTPS URL without query or fragment");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported routed providers at runtime", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "deepseek/deepseek-v4-pro",
          provider: "opneai",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "MISSPELLED_PROVIDER_KEY",
        },
      ]),
      MISSPELLED_PROVIDER_KEY: "route-key",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_PROVIDER_ROUTES_JSON[0].provider must be one of openrouter, openai, azure-openai, azure-foundry");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects managed identity on non-Azure routed providers at runtime", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "gpt-4o",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          authMode: "managed_identity",
          apiKeyEnv: "OPENAI_ROUTE_KEY",
        },
      ]),
      OPENAI_ROUTE_KEY: "route-key",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_PROVIDER_ROUTES_JSON[0].authMode managed_identity is only supported for Azure routes");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects plaintext global provider endpoints at runtime", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "http://corgtex-foundry.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "foundry-key",
      MODEL_CHAT_DEFAULT: "corgtex-ds-v4-flash",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_BASE_URL must be an HTTPS URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.openai.com/v1?api-version=bad",
    "https://api.openai.com/v1#fragment",
    "https://user:pass@api.openai.com/v1",
    "https://api.openai.com:444/v1",
  ])("rejects query or fragment components in global provider endpoints at runtime: %s", async (modelBaseUrl) => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openai",
      MODEL_API_KEY: "openai-key",
      MODEL_BASE_URL: modelBaseUrl,
      MODEL_CHAT_DEFAULT: "gpt-4o",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_BASE_URL must be an HTTPS URL without query or fragment");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Azure API key auth to non-Azure global endpoints at runtime", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://attacker.example/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "foundry-key",
      MODEL_CHAT_DEFAULT: "corgtex-ds-v4-flash",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("azure-foundry API key authentication requires a trusted Azure OpenAI-compatible /openai/v1 base URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://corgtex-foundry.services.ai.azure.com/openai",
    "https://corgtex-foundry.services.ai.azure.com/openai/v2",
    "https://corgtex-foundry.services.ai.azure.com/openai/v1?api-version=2026-07-29",
    "https://user:pass@corgtex-foundry.services.ai.azure.com/openai/v1",
    "https://corgtex-foundry.services.ai.azure.com:444/openai/v1",
  ])("rejects Azure-compatible endpoints without an exact /openai/v1 base path: %s", async (modelBaseUrl) => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: modelBaseUrl,
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "foundry-key",
      MODEL_CHAT_DEFAULT: "corgtex-ds-v4-flash",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const expectedError = modelBaseUrl.includes("?") || modelBaseUrl.includes("@") || modelBaseUrl.includes(":444")
      ? "MODEL_BASE_URL must be an HTTPS URL without query or fragment"
      : "azure-foundry API key authentication requires a trusted Azure OpenAI-compatible /openai/v1 base URL";

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow(expectedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects route-specific Azure API keys to non-Azure endpoints at runtime", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      FOUNDRY_ROUTE_KEY: "foundry-route-key",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-ds-v4-flash",
          provider: "azure-foundry",
          baseUrl: "https://attacker.example/openai/v1",
          authMode: "api_key",
          apiKeyEnv: "FOUNDRY_ROUTE_KEY",
        },
      ]),
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "corgtex-ds-v4-flash",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("azure-foundry API key authentication requires a trusted Azure OpenAI-compatible /openai/v1 base URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an explicit key env when a non-Azure route changes providers", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "gpt-4o",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
        },
      ]),
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_PROVIDER_ROUTES_JSON route for gpt-4o requires apiKeyEnv when provider differs from MODEL_PROVIDER");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an explicit key env when a non-Azure route overrides the endpoint", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "deepseek/deepseek-v4-pro",
          provider: "openrouter",
          baseUrl: "https://alternate-openrouter.example.test/v1",
        },
      ]),
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    await expect(openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow("MODEL_PROVIDER_ROUTES_JSON route for deepseek/deepseek-v4-pro requires apiKeyEnv when overriding baseUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps unrouted models on OpenRouter when a Foundry provider route exists", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      APP_URL: "https://corgtex.example.test",
      MODEL_CHAT_DEFAULT: "deepseek/deepseek-v4-flash",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-gpt56-luna",
          provider: "azure-foundry",
          baseUrl: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
          authMode: "managed_identity",
        },
      ]),
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "OpenRouter answer" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const chat = await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toMatchObject({
      authorization: "Bearer openrouter-key",
      "content-type": "application/json",
      "HTTP-Referer": "https://corgtex.example.test",
      "X-Title": "Corgtex",
    });
    expect(body).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      provider: {
        allow_fallbacks: true,
        data_collection: "deny",
        require_parameters: true,
      },
    });
    expect(azureIdentityMock.getToken).not.toHaveBeenCalled();
    expect(chat.usage).toMatchObject({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
    });
  });

  it("omits custom temperature for the Azure Foundry GPT 5.6 Luna fallback alias", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "foundry-key",
      MODEL_CHAT_DEFAULT: "corgtex-gpt56-luna",
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Foundry answer" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const chat = await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(body).toMatchObject({
      model: "corgtex-gpt56-luna",
    });
    expect(body.temperature).toBeUndefined();
    expect(chat.usage).toMatchObject({
      provider: "azure-foundry",
      model: "corgtex-gpt56-luna",
      rawProviderCostUsd: "0.004000",
      estimatedCostUsd: "0.008000",
    });
  });

  it("omits custom temperature for deployed Azure Foundry GPT 5.6 Sol and Terra aliases", async () => {
    const expectedRawCostByModel = new Map([
      ["corgtex-gpt56-terra", "0.010000"],
      ["corgtex-gpt56-sol", "0.020000"],
    ]);

    for (const model of expectedRawCostByModel.keys()) {
      restoreEnv();
      vi.resetModules();
      Object.assign(process.env, {
        MODEL_PROVIDER: "azure-foundry",
        MODEL_BASE_URL: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
        AZURE_OPENAI_AUTH_MODE: "api_key",
        AZURE_OPENAI_API_KEY: "foundry-key",
        MODEL_CHAT_DEFAULT: model,
      });

      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "Foundry answer" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }), { status: 200 }));

      vi.stubGlobal("fetch", fetchMock);

      const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

      const chat = await openAICompatibleModelGateway.chat({
        workspaceId: "ws-1",
        taskType: "CHAT",
        messages: [{ role: "user", content: "Hello" }],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;

      expect(body).toMatchObject({ model });
      expect(body.temperature).toBeUndefined();
      expect(chat.usage).toMatchObject({
        provider: "azure-foundry",
        model,
        rawProviderCostUsd: expectedRawCostByModel.get(model),
      });
      vi.unstubAllGlobals();
    }
  });

  it("omits custom temperature for configured Luna deployment aliases", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "foundry-key",
      MODEL_CHAT_DEFAULT: "corgtex-luna-enterprise",
      MODEL_OMIT_TEMPERATURE_MODELS: "corgtex-luna-enterprise",
      MODEL_PRICE_OVERRIDES_JSON: JSON.stringify([
        {
          provider: "azure-foundry",
          model: "corgtex-luna-enterprise",
          inputUsdPerToken: 0.000001,
          outputUsdPerToken: 0.000006,
        },
      ]),
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Foundry answer" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");

    const chat = await openAICompatibleModelGateway.chat({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(body).toMatchObject({
      model: "corgtex-luna-enterprise",
    });
    expect(body.temperature).toBeUndefined();
    expect(chat.usage).toMatchObject({
      provider: "azure-foundry",
      model: "corgtex-luna-enterprise",
      rawProviderCostUsd: "0.004000",
      estimatedCostUsd: "0.008000",
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

  it("blocks Azure Foundry streams before the provider call when deployment pricing is missing", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "foundry-key",
      MODEL_CHAT_DEFAULT: "unpriced-foundry-deployment",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const stream = openAICompatibleModelGateway.chatStream({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });

    await expect(stream.next()).rejects.toThrow("Missing model price for azure-foundry/unpriced-foundry-deployment");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records priced Azure Foundry streaming usage from stream usage chunks", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "azure-foundry",
      MODEL_BASE_URL: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
      AZURE_OPENAI_AUTH_MODE: "api_key",
      AZURE_OPENAI_API_KEY: "foundry-key",
      MODEL_CHAT_DEFAULT: "corgtex-kimi-k25",
    });

    const encoder = new TextEncoder();
    const streamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"Foundry\"}}]}\n\n"));
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\" stream\"}}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":500}}\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(streamBody, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const chunks: string[] = [];
    const stream = openAICompatibleModelGateway.chatStream({
      workspaceId: "ws-1",
      taskType: "CHAT",
      messages: [{ role: "user", content: "Hello" }],
    });

    let next = await stream.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await stream.next();
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(chunks.join("")).toBe("Foundry stream");
    expect(url).toBe("https://corgtex-foundry.services.ai.azure.com/openai/v1/chat/completions");
    expect(body).toMatchObject({
      model: "corgtex-kimi-k25",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(next.value.usage).toMatchObject({
      provider: "azure-foundry",
      model: "corgtex-kimi-k25",
      rawProviderCostUsd: "0.002100",
      estimatedCostUsd: "0.004200",
    });
  });

  it("streams ordered content and split indexed tool-call events from one required request", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter", MODEL_API_KEY: "test-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1", APP_URL: "https://corgtex.example.test",
      MODEL_CHAT_DEFAULT: "qwen/qwen3-32b",
    });
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"b":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_", function: { name: "respond_", arguments: '{"a":"' } }] } }] },
      { choices: [{ delta: { content: "café 漢" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "other", arguments: '"2"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "conversation", arguments: 'ok"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "" } }] } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ];
    const bytes = new TextEncoder().encode(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\ndata: {"truncated"`);
    const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const usageModule = await import("./usage");
    vi.mocked(usageModule.recordModelUsage).mockClear();
    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const stream = openAICompatibleModelGateway.chatEventStream({
      workspaceId: "ws-1", taskType: "AGENT", messages: [{ role: "user", content: "route" }],
      tools: [{ type: "function", function: { name: "respond_conversation", description: "route", parameters: {} } }],
      tool_choice: "required",
    });
    const events = [];
    let next = await stream.next();
    while (!next.done) { events.push(next.value); next = await stream.next(); }
    expect(events).toContainEqual({ type: "content_delta", content: "café 漢" });
    expect(events[0]).toMatchObject({ type: "tool_call_delta", index: 1, argumentsDelta: '{"b":' });
    expect(next.value.tool_calls).toEqual([
      { id: "call_a", type: "function", function: { name: "respond_conversation", arguments: '{"a":"ok"}' } },
      { id: "call_b", type: "function", function: { name: "other", arguments: '{"b":"2"}' } },
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ tool_choice: "required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(usageModule.recordModelUsage)).toHaveBeenCalledTimes(1);
  });

  it("preserves bounded pre-stream retries for event consumers", async () => {
    restoreEnv();
    Object.assign(process.env, { MODEL_PROVIDER: "openrouter", MODEL_API_KEY: "test-key", MODEL_BASE_URL: "https://openrouter.ai/api/v1", MODEL_CHAT_DEFAULT: "qwen/qwen3-32b" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("retry", { status: 429 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const usageModule = await import("./usage");
    vi.mocked(usageModule.recordModelUsage).mockClear();
    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const events = [];
    for await (const event of openAICompatibleModelGateway.chatEventStream({ workspaceId: "ws-1", taskType: "CHAT", messages: [] })) events.push(event);
    expect(events).toEqual([{ type: "content_delta", content: "ok" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(usageModule.recordModelUsage)).toHaveBeenCalledTimes(1);
  });
  it.each(["chatEventStream", "chatStream"] as const)("rejects clean EOF before [DONE] through %s and records usage once", async (method) => {
    restoreEnv(); Object.assign(process.env, { MODEL_PROVIDER: "openrouter", MODEL_API_KEY: "test-key", MODEL_BASE_URL: "https://openrouter.ai/api/v1", MODEL_CHAT_DEFAULT: "qwen/qwen3-32b" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { status: 200 })));
    const usageModule = await import("./usage"); vi.mocked(usageModule.recordModelUsage).mockClear();
    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const consume = async () => { for await (const _ of openAICompatibleModelGateway[method]({ workspaceId: "ws-1", taskType: "CHAT", messages: [] })) { /* consume */ } };
    await expect(consume()).rejects.toMatchObject({ name: "ChatStreamProtocolError" });
    expect(vi.mocked(usageModule.recordModelUsage)).toHaveBeenCalledTimes(1);
  });
  it.each([["malformed JSON", 'data: {"choices":BROKEN}'], ["a non-array tool-call container", `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: { index: 0 } } }] })}`], ["non-string content", `data: ${JSON.stringify({ choices: [{ delta: { content: 7 } }] })}`]])("rejects %s between tool argument fragments", async (_label, middle) => {
    restoreEnv(); Object.assign(process.env, { MODEL_PROVIDER: "openrouter", MODEL_API_KEY: "test-key", MODEL_BASE_URL: "https://openrouter.ai/api/v1", MODEL_CHAT_DEFAULT: "qwen/qwen3-32b" });
    const first = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "tool", arguments: '{"x":' } }] } }] }; const last = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify(first)}\n\n${middle}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`, { status: 200 })));
    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const consume = async () => { for await (const _ of openAICompatibleModelGateway.chatEventStream({ workspaceId: "ws-1", taskType: "CHAT", messages: [] })) { /* consume */ } }; await expect(consume()).rejects.toMatchObject({ name: "ChatStreamProtocolError" });
  });
  it("treats nullable optional tool continuation fields as absent", async () => {
    restoreEnv(); Object.assign(process.env, { MODEL_PROVIDER: "openrouter", MODEL_API_KEY: "test-key", MODEL_BASE_URL: "https://openrouter.ai/api/v1", MODEL_CHAT_DEFAULT: "qwen/qwen3-32b" });
    const tools = [
      { index: 0, id: "call_a", type: "function", function: { name: "tool", arguments: '{"x":' } },
      { index: 0, id: null, type: null, function: null },
      { index: 0, id: null, type: null, function: { name: null, arguments: "1}" } },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`${tools.map((tool) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tool] } }] })}\n\n`).join("")}data: ${JSON.stringify({ choices: [{ delta: { tool_calls: null } }] })}\n\ndata: [DONE]\n\n`, { status: 200 })));
    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const stream = openAICompatibleModelGateway.chatEventStream({ workspaceId: "ws-1", taskType: "CHAT", messages: [] });
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    expect(next.value.tool_calls?.[0]).toMatchObject({ id: "call_a", function: { name: "tool", arguments: '{"x":1}' } });
  });

  it.each([
    ["an invalid index", { index: -1, id: "call_a", function: { name: "tool", arguments: "{}" } }],
    ["an invalid id fragment", { index: 0, id: 7, function: { name: "tool", arguments: "{}" } }],
    ["an invalid name fragment", { index: 0, id: "call_a", function: { name: 7, arguments: "{}" } }],
    ["an invalid non-null type", { index: 0, id: "call_a", type: 7, function: { name: "tool", arguments: "{}" } }],
    ["an invalid non-null function", { index: 0, id: "call_a", function: 7 }],
    ["an incomplete identity", { index: 0, function: { arguments: "{}" } }],
  ])("fails closed on %s and records accepted-request usage once", async (_label, tool) => {
    restoreEnv();
    Object.assign(process.env, { MODEL_PROVIDER: "openrouter", MODEL_API_KEY: "test-key", MODEL_BASE_URL: "https://openrouter.ai/api/v1", MODEL_CHAT_DEFAULT: "qwen/qwen3-32b" });
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tool] } }] })}\n\ndata: [DONE]\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(payload, { status: 200 })));
    const usageModule = await import("./usage");
    vi.mocked(usageModule.recordModelUsage).mockClear();
    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const consume = async () => { for await (const _ of openAICompatibleModelGateway.chatEventStream({ workspaceId: "ws-1", taskType: "CHAT", messages: [] })) { /* consume */ } };
    await expect(consume()).rejects.toMatchObject({ name: "ChatStreamProtocolError" });
    expect(vi.mocked(usageModule.recordModelUsage)).toHaveBeenCalledTimes(1);
  });

  it("records estimated Azure Foundry streaming usage when the consumer closes early", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-kimi-k25",
          provider: "azure-foundry",
          baseUrl: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
          authMode: "api_key",
          apiKeyEnv: "AZURE_FOUNDRY_ROUTE_KEY",
        },
      ]),
      AZURE_FOUNDRY_ROUTE_KEY: "foundry-key",
    });

    const usageModule = await import("./usage");
    vi.mocked(usageModule.recordModelUsage).mockClear();

    const encoder = new TextEncoder();
    const cancelMock = vi.fn();
    const streamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"Foundry\"}}]}\n\n"));
      },
      cancel: cancelMock,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(streamBody, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const longPrompt = "x".repeat(4_000);
    const stream = openAICompatibleModelGateway.chatStream({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "corgtex-kimi-k25",
      messages: [{ role: "user", content: longPrompt }],
    });

    const first = await stream.next();
    expect(first.value).toBe("Foundry");

    await stream.return({
      content: "",
      usage: {
        provider: "azure-foundry",
        model: "corgtex-kimi-k25",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        estimatedCostUsd: "0.000000",
        rawProviderCostUsd: "0.000000",
        billableCostUsd: "0.000000",
      },
    });

    expect(cancelMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const expectedInputTokens = Math.ceil(String(init.body).length / 4);
    const expectedOutputTokens = Math.ceil("Foundry".length / 4);
    const expectedRawCostUsd = (
      expectedInputTokens * 0.0000006 +
      expectedOutputTokens * 0.000003
    ).toFixed(6);
    const expectedEstimatedCostUsd = (
      (expectedInputTokens * 0.0000006 + expectedOutputTokens * 0.000003) * 2
    ).toFixed(6);
    expect(vi.mocked(usageModule.recordModelUsage).mock.calls.at(-1)?.[0]).toMatchObject({
      provider: "azure-foundry",
      model: "corgtex-kimi-k25",
      inputTokens: expectedInputTokens,
      outputTokens: expectedOutputTokens,
      rawProviderCostUsd: expectedRawCostUsd,
      estimatedCostUsd: expectedEstimatedCostUsd,
    });
  });

  it("includes tool schemas and streamed tool-call arguments in early-close usage estimates", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "openrouter-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MODEL_PROVIDER_ROUTES_JSON: JSON.stringify([
        {
          model: "corgtex-kimi-k25",
          provider: "azure-foundry",
          baseUrl: "https://corgtex-foundry.services.ai.azure.com/openai/v1",
          authMode: "api_key",
          apiKeyEnv: "AZURE_FOUNDRY_ROUTE_KEY",
        },
      ]),
      AZURE_FOUNDRY_ROUTE_KEY: "foundry-key",
    });

    const usageModule = await import("./usage");
    vi.mocked(usageModule.recordModelUsage).mockClear();

    const encoder = new TextEncoder();
    const cancelMock = vi.fn();
    const streamedArguments = "z".repeat(4_000);
    const toolDelta = JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [0, 1].map((index) => ({ index, id: `call_${index}`, function: { name: "lookup_customer", arguments: streamedArguments } })),
        },
      }],
    });
    const contentDelta = JSON.stringify({ choices: [{ delta: { content: "Foundry" } }] });
    const streamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${toolDelta}\n\ndata: ${contentDelta}\n\n`));
      },
      cancel: cancelMock,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(streamBody, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const stream = openAICompatibleModelGateway.chatEventStream({
      workspaceId: "ws-1",
      taskType: "CHAT",
      model: "corgtex-kimi-k25",
      messages: [{ role: "user", content: "short prompt" }],
      tools: [{
        type: "function",
        function: {
          name: "lookup_customer",
          description: "y".repeat(4_000),
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      }],
    });

    const first = await stream.next();
    expect(first.value).toMatchObject({ type: "tool_call_delta", index: 0 });

    await stream.return({
      content: "",
      usage: {
        provider: "azure-foundry",
        model: "corgtex-kimi-k25",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        estimatedCostUsd: "0.000000",
        rawProviderCostUsd: "0.000000",
        billableCostUsd: "0.000000",
      },
    });

    expect(cancelMock).toHaveBeenCalledTimes(1);
    const recordedUsage = vi.mocked(usageModule.recordModelUsage).mock.calls.at(-1)?.[0];
    expect(recordedUsage).toMatchObject({
      provider: "azure-foundry",
      model: "corgtex-kimi-k25",
    });
    expect(recordedUsage?.inputTokens).toBeGreaterThan(1000);
    expect(recordedUsage?.outputTokens).toBeGreaterThan(2000);
    expect(Number(recordedUsage?.rawProviderCostUsd)).toBeGreaterThan(0.003);
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

  it("aborts a pending streaming provider read when the request signal aborts", async () => {
    restoreEnv();
    Object.assign(process.env, {
      MODEL_PROVIDER: "openrouter",
      MODEL_API_KEY: "test-key",
      MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      APP_URL: "https://corgtex.example.test",
      MODEL_CHAT_DEFAULT: "qwen/qwen3-32b",
    });

    let providerSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      providerSignal = init.signal as AbortSignal;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          providerSignal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          }, { once: true });
        },
      }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { openAICompatibleModelGateway } = await import("./openai-compatible-gateway");
    const controller = new AbortController();
    const stream = openAICompatibleModelGateway.chatStream({
      workspaceId: "ws-1",
      taskType: "AGENT",
      messages: [{ role: "user", content: "Hello" }],
      signal: controller.signal,
    });

    const pendingRead = stream.next();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(providerSignal).toBeInstanceOf(AbortSignal);
    });

    expect(providerSignal?.aborted).toBe(false);
    controller.abort();

    await expect(pendingRead).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
