import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callCandidateWithRetries,
  conceptMatches,
  estimateCost,
  evaluationPasses,
  isRetryableRequestError,
  parseCandidates,
  scoreItem,
} from "./azure-foundry-model-eval.mjs";

afterEach(() => {
  delete process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON;
  delete process.env.AZURE_FOUNDRY_EVAL_PASS_POLICY;
  delete process.env.MODEL_API_KEY;
  delete process.env.MODEL_PRICE_OVERRIDES_JSON;
  vi.unstubAllGlobals();
});

describe("Azure Foundry model eval helpers", () => {
  it("preserves token metrics when candidate pricing is unavailable", () => {
    const cost = estimateCost(
      { provider: "azure-foundry", model: "unpriced-candidate" },
      { prompt_tokens: 12, completion_tokens: 5 },
      "short answer",
      { messages: [{ role: "user", content: "Prompt text" }] },
    );

    expect(cost).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      estimatedInputTokens: false,
      estimatedOutputTokens: false,
      rawProviderCostUsd: null,
    });
  });

  it("estimates usage when provider token counts are negative", () => {
    const cost = estimateCost(
      { provider: "openai", model: "gpt-4o" },
      { prompt_tokens: -100, completion_tokens: -5 },
      "answer text",
      { messages: [{ role: "user", content: "Prompt text" }] },
    );

    expect(cost).toEqual({
      inputTokens: 3,
      outputTokens: 3,
      estimatedInputTokens: true,
      estimatedOutputTokens: true,
      rawProviderCostUsd: "0.000038",
    });
  });

  it("rejects invalid price overrides before reporting candidate cost", () => {
    process.env.MODEL_PRICE_OVERRIDES_JSON = JSON.stringify([
      { provider: "azure-foundry", model: "custom-candidate", inputUsdPerToken: -1, outputUsdPerToken: 0 },
    ]);

    expect(() => estimateCost(
      { provider: "azure-foundry", model: "custom-candidate" },
      { prompt_tokens: 2, completion_tokens: 3 },
      "answer",
      { messages: [{ role: "user", content: "Prompt" }] },
    )).toThrow("MODEL_PRICE_OVERRIDES_JSON[0].inputUsdPerToken must be a finite non-negative number");
  });

  it("includes known OpenAI rollback prices in cost estimates", () => {
    const cost = estimateCost(
      { provider: "openai", model: "gpt-4o" },
      { prompt_tokens: 10, completion_tokens: 4 },
      "answer",
      { messages: [{ role: "user", content: "Prompt" }] },
    );

    expect(cost.rawProviderCostUsd).toBe("0.000065");
  });

  it("includes production OpenRouter rollback prices in cost estimates", () => {
    const cost = estimateCost(
      { provider: "openrouter", model: "qwen/qwen3-32b" },
      { prompt_tokens: 10, completion_tokens: 4 },
      "answer",
      { messages: [{ role: "user", content: "Prompt" }] },
    );

    expect(cost.rawProviderCostUsd).toBe("0.000002");
  });

  it("requires parsed JSON before a JSON-mode case can pass", () => {
    const score = scoreItem({ mode: "json", requiredConcepts: ["ready"] }, "ready");

    expect(score.jsonParsed).toBe(false);
    expect(score.schemaValid).toBe(false);
    expect(score.passed).toBe(false);
  });

  it("requires standalone JSON before a JSON-mode case can pass", () => {
    const score = scoreItem(
      { mode: "json", requiredKeys: ["summary"] },
      "Here is the object: {\"summary\":\"Structured answer\"}",
    );

    expect(score.jsonParsed).toBe(false);
    expect(score.schemaValid).toBe(false);
    expect(score.passed).toBe(false);
  });

  it("scores JSON concepts from parsed values, not field names", () => {
    const score = scoreItem(
      {
        mode: "json",
        requiredKeys: ["unsafeToSend"],
        requiredConcepts: ["unsafe"],
      },
      "{\"unsafeToSend\":false,\"proposedReply\":\"Needs approval before sending.\"}",
    );

    expect(score.schemaValid).toBe(true);
    expect(score.missingConcepts).toEqual(["unsafe"]);
    expect(score.passed).toBe(false);
  });

  it("enforces required JSON values", () => {
    const score = scoreItem(
      {
        mode: "json",
        requiredKeys: ["replyNeeded", "unsafeToSend"],
        requiredJsonValues: {
          replyNeeded: true,
          unsafeToSend: true,
        },
      },
      "{\"replyNeeded\":true,\"unsafeToSend\":false}",
    );

    expect(score.incorrectJsonValues).toEqual(["unsafeToSend"]);
    expect(score.passed).toBe(false);
  });

  it("rejects scalar placeholders for required JSON arrays", () => {
    const item = {
      mode: "json",
      requiredKeys: ["actions"],
      requiredJsonShapes: {
        actions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            requiredKeys: ["title", "owner", "dueDate", "evidence"],
            properties: {
              title: { type: "string" },
              owner: { type: "string" },
              dueDate: { type: "string" },
              evidence: { type: "string" },
            },
          },
        },
      },
    };

    const scalarScore = scoreItem(item, "{\"actions\":\"Jordan buyer shortlist 2026-08-03\"}");
    expect(scalarScore.schemaValid).toBe(false);
    expect(scalarScore.invalidJsonShapes).toEqual(["actions must be an array"]);
    expect(scalarScore.passed).toBe(false);

    const wrongFieldTypeScore = scoreItem(item, "{\"actions\":[{\"title\":[\"Buyer shortlist\"],\"owner\":42,\"dueDate\":\"2026-08-03\",\"evidence\":{\"source\":\"Notes\"}}]}");
    expect(wrongFieldTypeScore.schemaValid).toBe(false);
    expect(wrongFieldTypeScore.invalidJsonShapes).toEqual([
      "actions[0].title must be a string",
      "actions[0].owner must be a string",
      "actions[0].evidence must be a string",
    ]);
    expect(wrongFieldTypeScore.passed).toBe(false);

    const nestedScore = scoreItem(item, "{\"actions\":[{\"title\":\"Buyer shortlist\",\"owner\":\"Jordan\",\"dueDate\":\"2026-08-03\",\"evidence\":\"Notes\"}]}");
    expect(nestedScore.schemaValid).toBe(true);
    expect(nestedScore.invalidJsonShapes).toEqual([]);
  });

  it("rejects null placeholders for structured meeting summary sections", () => {
    const item = {
      mode: "json",
      requiredKeys: ["summary", "decisions", "actions", "risks"],
      requiredJsonShapes: {
        summary: { type: "string" },
        decisions: { type: "array", minItems: 1, items: { type: "string" } },
        actions: { type: "array", minItems: 1, items: { type: "string" } },
        risks: { type: "array", minItems: 1, items: { type: "string" } },
      },
      requiredJsonMatches: [
        {
          label: "meeting summary structured sections",
          path: "",
          fields: {
            decisions: { allOf: ["Barcelona pilot", ["proceed", "approved"], ["no external announcement", "external announcement yet"]] },
            actions: { allOf: ["Mina", "vendor cap", "Friday", "Support", ["two days", "2 days"]] },
            risks: { allOf: ["Data import", ["risk", "risky", "remains a risk"], ["duplicate company rows", "duplicate rows"]] },
          },
        },
      ],
      requiredConcepts: [
        { label: "Barcelona pilot", anyOf: ["Barcelona pilot"] },
        { label: "finance deadline", allOf: ["finance", "vendor cap", "Friday"] },
        { label: "Support notice", allOf: ["Support", ["two days", "2 days"]] },
        { label: "duplicate company rows", anyOf: ["duplicate company rows"] },
      ],
    };

    const score = scoreItem(
      item,
      "{\"summary\":\"Barcelona pilot has duplicate company rows.\",\"decisions\":null,\"actions\":null,\"risks\":null}",
    );

    expect(score.schemaValid).toBe(false);
    expect(score.invalidJsonShapes).toEqual([
      "decisions must be an array",
      "actions must be an array",
      "risks must be an array",
    ]);
    expect(score.passed).toBe(false);

    const placeholderScore = scoreItem(
      item,
      "{\"summary\":\"Barcelona pilot, Mina, vendor cap by Friday, Data import risk, duplicate company rows.\",\"decisions\":[null],\"actions\":[null],\"risks\":[null]}",
    );
    expect(placeholderScore.schemaValid).toBe(false);
    expect(placeholderScore.invalidJsonShapes).toEqual([
      "decisions[0] must be a string",
      "actions[0] must be a string",
      "risks[0] must be a string",
    ]);
    expect(placeholderScore.missingJsonMatches).toEqual(["meeting summary structured sections"]);
    expect(placeholderScore.passed).toBe(false);

    const summaryOnlyScore = scoreItem(
      item,
      "{\"summary\":\"The Barcelona pilot can proceed if finance confirms the vendor cap by Friday. No external announcement yet. Mina owns the vendor cap and Support needs two days of notice. Data import remains a risk because of duplicate company rows.\",\"decisions\":[\"General decision\"],\"actions\":[\"General action\"],\"risks\":[\"General risk\"]}",
    );
    expect(summaryOnlyScore.schemaValid).toBe(true);
    expect(summaryOnlyScore.missingConcepts).toEqual([]);
    expect(summaryOnlyScore.missingJsonMatches).toEqual(["meeting summary structured sections"]);
    expect(summaryOnlyScore.passed).toBe(false);

    const matchedScore = scoreItem(
      item,
      "{\"summary\":\"Barcelona pilot planning is in scope.\",\"decisions\":[\"Proceed with Barcelona pilot planning; no external announcement yet.\"],\"actions\":[\"Mina owns the finance vendor cap check by Friday and will include Support's two days of notice in the launch note.\"],\"risks\":[\"Data import remains risky because of duplicate company rows.\"]}",
    );
    expect(matchedScore.schemaValid).toBe(true);
    expect(matchedScore.missingJsonMatches).toEqual([]);
    expect(matchedScore.passed).toBe(true);
  });

  it("requires related JSON fields to match within the same object", () => {
    const item = {
      mode: "json",
      requiredKeys: ["actions"],
      requiredJsonShapes: {
        actions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            requiredKeys: ["title", "owner", "dueDate", "evidence"],
            properties: {
              title: { type: "string" },
              owner: { type: "string" },
              dueDate: { type: "string" },
              evidence: { type: "string" },
            },
          },
        },
      },
      requiredJsonMatches: [
        {
          label: "Jordan shortlist action",
          path: "actions",
          fields: {
            owner: "Jordan",
            title: "buyer shortlist",
            dueDate: { anyOf: ["2026-08-03", "August 3"] },
          },
        },
        {
          label: "Priya DPA blocker action",
          path: "actions",
          fields: {
            owner: "Priya",
            title: "DPA",
            evidence: "legal",
          },
        },
      ],
    };

    const swappedScore = scoreItem(item, JSON.stringify({
      actions: [
        { title: "Legal DPA blocker", owner: "Jordan", dueDate: "2026-08-03", evidence: "Waiting on legal" },
        { title: "Buyer shortlist", owner: "Priya", dueDate: "2026-08-03", evidence: "Notes" },
      ],
    }));
    expect(swappedScore.schemaValid).toBe(true);
    expect(swappedScore.missingJsonMatches).toEqual([
      "Jordan shortlist action",
      "Priya DPA blocker action",
    ]);
    expect(swappedScore.passed).toBe(false);

    const matchedScore = scoreItem(item, JSON.stringify({
      actions: [
        { title: "Prepare buyer shortlist", owner: "Jordan", dueDate: "2026-08-03", evidence: "Jordan will prepare the buyer shortlist" },
        { title: "DPA approval blocker", owner: "Priya", dueDate: "", evidence: "Waiting on legal to approve the DPA" },
      ],
    }));
    expect(matchedScore.missingJsonMatches).toEqual([]);
    expect(matchedScore.passed).toBe(true);
  });

  it("requires CRM extraction concepts in their target fields", () => {
    const item = {
      mode: "json",
      requiredKeys: ["company", "contact", "need", "timeline", "followUp"],
      requiredJsonShapes: {
        company: { type: "string" },
        contact: { type: "string" },
        need: { type: "string" },
        timeline: { type: "string" },
        followUp: { type: "string" },
      },
      requiredJsonMatches: [
        {
          label: "CRM extracted fields",
          path: "",
          fields: {
            company: "RidgeWorks",
            contact: "Elena",
            need: { allOf: ["governed AI workspace", "45 operators", "procurement approval"] },
            timeline: { anyOf: ["September pilot", "September"] },
            followUp: { allOf: ["security docs", "pricing overview"] },
          },
        },
      ],
      requiredConcepts: [
        "RidgeWorks",
        "Elena",
        "45 operators",
        "procurement approval",
        "September pilot",
        "security docs",
        "pricing overview",
      ],
    };

    const concentratedScore = scoreItem(item, JSON.stringify({
      company: "RidgeWorks Elena governed AI workspace 45 operators procurement approval September pilot security docs pricing overview",
      contact: null,
      need: null,
      timeline: null,
      followUp: null,
    }));
    expect(concentratedScore.schemaValid).toBe(false);
    expect(concentratedScore.missingJsonMatches).toEqual(["CRM extracted fields"]);
    expect(concentratedScore.passed).toBe(false);

    const matchedScore = scoreItem(item, JSON.stringify({
      company: "RidgeWorks",
      contact: "Elena",
      need: "Governed AI workspace for 45 operators requiring procurement approval",
      timeline: "September pilot",
      followUp: "Send security docs and a short pricing overview",
    }));
    expect(matchedScore.schemaValid).toBe(true);
    expect(matchedScore.missingJsonMatches).toEqual([]);
    expect(matchedScore.passed).toBe(true);
  });

  it("requires proposal drafts to include objections to test", () => {
    const item = {
      mode: "text",
      requiredTextSections: [
        {
          label: "substantive objections to test",
          heading: {
            anyOf: [
              "objections to test",
              "test objections",
              "objection",
              "objections",
              "concerns to test",
              "risks to test",
            ],
          },
          concepts: [
            {
              label: "substantive objection",
              allOf: [
                ["approval controls", "approval", "review"],
                ["before any draft leaves", "before sending", "send"],
              ],
            },
          ],
        },
      ],
      requiredConcepts: [
        { label: "internal-only scope", anyOf: ["internal workspace only", "internal workspace"] },
        { label: "drafting only", anyOf: ["draft emails", "draft email", "drafts emails"] },
        { label: "cannot send", anyOf: ["cannot send", "not send", "must not send", "no sending"] },
        { label: "review date", anyOf: ["2026-08-15", "August 15"] },
        { label: "sample size", anyOf: ["ten sampled drafts", "10 sampled drafts", "ten drafts", "10 drafts"] },
      ],
    };

    const summaryOnlyScore = scoreItem(
      item,
      "Intent: enable CRM follow-up assistance. Scope: internal workspace only. The assistant may draft emails but cannot send. Review on 2026-08-15 after ten sampled drafts.",
    );
    expect(summaryOnlyScore.missingConcepts).toEqual([]);
    expect(summaryOnlyScore.missingTextSections).toEqual(["substantive objections to test"]);
    expect(summaryOnlyScore.passed).toBe(false);

    const emptyObjectionsScore = scoreItem(
      item,
      "Intent: enable CRM follow-up assistance.\nScope: internal workspace only. The assistant may draft emails but cannot send.\nObjections to test: none.\nReview on 2026-08-15 after ten sampled drafts.",
    );
    expect(emptyObjectionsScore.missingConcepts).toEqual([]);
    expect(emptyObjectionsScore.missingTextSections).toEqual(["substantive objections to test"]);
    expect(emptyObjectionsScore.passed).toBe(false);

    const matchedScore = scoreItem(
      item,
      "Intent: enable CRM follow-up assistance.\nScope: internal workspace only. The assistant may draft emails but cannot send.\nObjections to test: whether approval controls are enough before any draft leaves the workspace.\nReview on 2026-08-15 after ten sampled drafts.",
    );
    expect(matchedScore.missingConcepts).toEqual([]);
    expect(matchedScore.missingTextSections).toEqual([]);
    expect(matchedScore.passed).toBe(true);
  });

  it("requires Brain open questions and confidence to be usable fields", () => {
    const item = {
      mode: "json",
      requiredKeys: ["companyFacts", "openQuestions", "confidence"],
      requiredJsonShapes: {
        companyFacts: { type: "array", minItems: 1, items: { type: "string" } },
        openQuestions: { type: "array", minItems: 1, items: { type: "string" } },
        confidence: { type: "string" },
      },
      requiredJsonMatches: [
        {
          label: "Brain structured fields",
          path: "",
          fields: {
            companyFacts: {
              allOf: [
                ["two plants", "2 plants"],
                "Ohio",
                ["medical-device", "medical device"],
                ["lead time variance", "lead-time variance"],
                "Mexico warehouse",
                ["not approved", "unapproved"],
              ],
            },
            openQuestions: {
              allOf: [
                ["lead time variance", "lead-time variance"],
                ["measure", "metric", "target"],
              ],
            },
            confidence: "medium",
          },
        },
      ],
      requiredConcepts: [
        { label: "two Ohio plants", allOf: [["two plants", "2 plants"], "Ohio"] },
        { label: "medical-device customers", anyOf: ["medical-device", "medical device"] },
        { label: "lead-time variance", anyOf: ["lead time variance", "lead-time variance"] },
        { label: "Mexico warehouse unapproved", allOf: ["Mexico warehouse", ["not approved", "unapproved"]] },
      ],
    };

    const placeholderScore = scoreItem(item, JSON.stringify({
      companyFacts: [
        "Northstar Components runs two plants in Ohio, serves medical-device manufacturers, has a lead-time variance priority, and has a Mexico warehouse that is not approved.",
      ],
      openQuestions: null,
      confidence: null,
    }));
    expect(placeholderScore.schemaValid).toBe(false);
    expect(placeholderScore.invalidJsonShapes).toEqual([
      "openQuestions must be an array",
      "confidence must be a string",
    ]);
    expect(placeholderScore.missingJsonMatches).toEqual(["Brain structured fields"]);
    expect(placeholderScore.passed).toBe(false);

    const matchedScore = scoreItem(item, JSON.stringify({
      companyFacts: [
        "Northstar Components runs two plants in Ohio.",
        "It serves medical-device manufacturers.",
        "Its 2026 priority is reducing lead-time variance.",
        "The Mexico warehouse is not approved.",
      ],
      openQuestions: ["What metric will measure lead-time variance reduction?"],
      confidence: "medium",
    }));
    expect(matchedScore.schemaValid).toBe(true);
    expect(matchedScore.missingJsonMatches).toEqual([]);
    expect(matchedScore.passed).toBe(true);
  });

  it("requires text outputs to include named sections with matching content", () => {
    const item = {
      mode: "text",
      requiredTextSections: [
        {
          label: "decisions section",
          heading: "decisions",
          concepts: ["onboarding checklist"],
        },
        {
          label: "actions section",
          heading: "actions",
          concepts: ["Niko", "tomorrow"],
        },
        {
          label: "risks section",
          heading: "risks",
          concepts: [{ label: "Slack missing scope", allOf: ["Slack ingestion", "missing scope"] }],
        },
      ],
      requiredConcepts: [
        "onboarding checklist",
        "Niko",
        "tomorrow",
        { label: "Slack missing scope risk", allOf: ["Slack ingestion", "missing scope"] },
      ],
    };

    const unstructuredScore = scoreItem(
      item,
      "The governance circle accepted the onboarding checklist update; Niko will publish it tomorrow; Slack ingestion failed because of a missing scope.",
    );
    expect(unstructuredScore.missingConcepts).toEqual([]);
    expect(unstructuredScore.missingTextSections).toEqual([
      "decisions section",
      "actions section",
      "risks section",
    ]);
    expect(unstructuredScore.passed).toBe(false);

    const misplacedScore = scoreItem(
      item,
      "Decisions:\n- The governance circle accepted the onboarding checklist update.\nActions:\n- Niko will publish the checklist tomorrow.\nRisks:\n- No risks mentioned.",
    );
    expect(misplacedScore.missingTextSections).toEqual(["risks section"]);
    expect(misplacedScore.passed).toBe(false);

    const matchedScore = scoreItem(
      item,
      "Decisions: The governance circle accepted the onboarding checklist update.\nActions:\n- Niko will publish the checklist tomorrow.\nRisks:\n- Slack ingestion failed for one private channel due to missing scope.",
    );
    expect(matchedScore.missingTextSections).toEqual([]);
    expect(matchedScore.passed).toBe(true);
  });

  it("requires Slack triage to include a usable proposed reply", () => {
    const item = {
      mode: "json",
      requiredKeys: ["replyNeeded", "proposedReply", "unsafeToSend"],
      requiredJsonValues: { replyNeeded: true, unsafeToSend: true },
      requiredJsonShapes: {
        proposedReply: { type: "string" },
      },
      requiredJsonMatches: [
        {
          label: "usable proposed reply",
          path: "",
          fields: {
            proposedReply: {
              allOf: [
                ["not send", "cannot send", "do not send"],
                "unreconciled cost numbers",
                "account owner",
                ["approval", "approved"],
              ],
            },
          },
        },
      ],
      requiredConcepts: [
        { label: "approval needed", allOf: [["approval", "approved"], "account owner"] },
        { label: "cost numbers risk", allOf: ["cost numbers", "unreconciled"] },
        { label: "unsafe to send", anyOf: ["not send", "cannot send", "do not send"] },
      ],
    };

    const nullReplyScore = scoreItem(item, JSON.stringify({
      replyNeeded: true,
      proposedReply: null,
      unsafeToSend: true,
      notes: "Do not send: unreconciled cost numbers need account owner approval",
    }));
    expect(nullReplyScore.schemaValid).toBe(false);
    expect(nullReplyScore.invalidJsonShapes).toEqual(["proposedReply must be a string"]);
    expect(nullReplyScore.missingJsonMatches).toEqual(["usable proposed reply"]);
    expect(nullReplyScore.passed).toBe(false);

    const matchedScore = scoreItem(item, JSON.stringify({
      replyNeeded: true,
      proposedReply: "Do not send the plan yet. The unreconciled cost numbers need account owner approval before sharing with the customer.",
      unsafeToSend: true,
    }));
    expect(matchedScore.schemaValid).toBe(true);
    expect(matchedScore.missingJsonMatches).toEqual([]);
    expect(matchedScore.passed).toBe(true);
  });

  it("defaults OpenAI evaluation candidates to MODEL_API_KEY", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "OpenAI rollback",
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);

    expect(parseCandidates()[0]).toMatchObject({
      provider: "openai",
      apiKeyEnv: "MODEL_API_KEY",
    });
  });

  it("requires explicit keys for custom OpenAI-compatible evaluation origins", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "OpenAI proxy",
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "https://proxy.example/v1",
      },
    ]);

    expect(() => parseCandidates()).toThrow("apiKeyEnv is required when openai uses a custom baseUrl");
  });

  it("allows custom evaluation origins with dedicated key envs", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "OpenRouter proxy",
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        baseUrl: "https://proxy.example/api/v1",
        apiKeyEnv: "OPENROUTER_PROXY_KEY",
      },
    ]);

    expect(parseCandidates()[0]).toMatchObject({
      provider: "openrouter",
      apiKeyEnv: "OPENROUTER_PROXY_KEY",
    });
  });

  it("defaults Azure Foundry API-key candidates to AZURE_FOUNDRY_API_KEY", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "Foundry candidate",
        provider: "azure-foundry",
        model: "corgtex-gpt56-luna",
        baseUrl: "https://corgtex-foundry-models-wus3.services.ai.azure.com/openai/v1",
      },
    ]);

    expect(parseCandidates()[0]).toMatchObject({
      provider: "azure-foundry",
      apiKeyEnv: "AZURE_FOUNDRY_API_KEY",
    });
  });

  it("defaults Azure OpenAI API-key candidates to AZURE_OPENAI_API_KEY", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "Azure OpenAI rollback",
        provider: "azure-openai",
        model: "corgtex-chat-quality",
        baseUrl: "https://oai-corgtex-ss-prod.openai.azure.com/openai/v1",
      },
    ]);

    expect(parseCandidates()[0]).toMatchObject({
      provider: "azure-openai",
      apiKeyEnv: "AZURE_OPENAI_API_KEY",
    });
  });

  it("evaluates candidate pass policy", () => {
    expect(evaluationPasses([{ passed: true }, { passed: true }], "all")).toBe(true);
    expect(evaluationPasses([{ passed: true }, { passed: false }], "all")).toBe(false);
    expect(evaluationPasses([{ passed: true }, { passed: false }], "any")).toBe(true);
    expect(evaluationPasses([{ passed: false }, { passed: false }], "any")).toBe(false);
  });

  it("rejects non-HTTPS evaluation candidate base URLs", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "OpenAI rollback",
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "http://api.openai.test/v1",
      },
    ]);

    expect(() => parseCandidates()).toThrow("AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[0].baseUrl must be an HTTPS URL");
  });

  it("rejects managed identity for non-Azure evaluation candidates", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "OpenRouter rollback",
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        baseUrl: "https://openrouter.ai/api/v1",
        authMode: "managed_identity",
      },
    ]);

    expect(() => parseCandidates()).toThrow("authMode managed_identity is only supported for Azure candidates");
  });

  it("rejects managed identity Azure evaluation candidates on non-Azure hosts", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "Foundry candidate",
        provider: "azure-foundry",
        model: "corgtex-gpt56-luna",
        baseUrl: "https://attacker.example/openai/v1",
        authMode: "managed_identity",
      },
    ]);

    expect(() => parseCandidates()).toThrow("baseUrl must be a trusted Azure OpenAI-compatible URL for managed identity");
  });

  it("rejects API-key Azure evaluation candidates on non-Azure hosts", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "Foundry candidate",
        provider: "azure-foundry",
        model: "corgtex-gpt56-luna",
        baseUrl: "https://attacker.example/openai/v1",
        authMode: "api_key",
      },
    ]);

    expect(() => parseCandidates()).toThrow("baseUrl must be a trusted Azure OpenAI-compatible URL for API key");
  });

  it("does not treat negated forbidden phrases as forbidden mentions", () => {
    const score = scoreItem({
      mode: "text",
      forbiddenConcepts: ["ready to send now"],
    }, "This is not ready to send now because legal approval is missing.");

    expect(score.forbiddenMentions).toEqual([]);
    expect(score.passed).toBe(true);
  });

  it("still catches unnegated forbidden phrases", () => {
    const score = scoreItem({
      mode: "text",
      forbiddenConcepts: ["ready to send now"],
    }, "The message is ready to send now.");

    expect(score.forbiddenMentions).toEqual(["ready to send now"]);
    expect(score.passed).toBe(false);
  });

  it("does not let a separate no-claim negate a forbidden assertion", () => {
    const score = scoreItem({
      mode: "text",
      forbiddenConcepts: ["ready to send now"],
    }, "No blockers remain and it is ready to send now.");

    expect(score.forbiddenMentions).toEqual(["ready to send now"]);
    expect(score.passed).toBe(false);
  });

  it("treats failed-to required facts as missing", () => {
    const score = scoreItem({
      mode: "json",
      requiredKeys: ["actions"],
      requiredJsonMatches: [
        {
          label: "Jordan shortlist action",
          path: "actions",
          fields: {
            owner: "Jordan",
            title: "buyer shortlist",
          },
        },
      ],
      requiredConcepts: [
        { label: "Jordan shortlist", allOf: ["Jordan", "buyer shortlist"] },
      ],
    }, JSON.stringify({
      actions: [
        {
          owner: "Jordan",
          title: "Jordan failed to prepare the buyer shortlist",
        },
      ],
    }));

    expect(score.missingJsonMatches).toEqual(["Jordan shortlist action"]);
    expect(score.missingConcepts).toEqual(["Jordan shortlist"]);
    expect(score.passed).toBe(false);
  });

  it("keeps polarity handling scoped to forbidden matching", () => {
    expect(conceptMatches(["ready to send now"], "not ready to send now")).toBe(true);
    expect(conceptMatches(["ready to send now"], "not ready to send now", { polarityAware: true })).toBe(false);
  });

  it("treats negated required facts as missing", () => {
    const score = scoreItem({
      mode: "json",
      requiredKeys: ["actions"],
      requiredJsonMatches: [
        {
          label: "Jordan shortlist action",
          path: "actions",
          fields: {
            owner: "Jordan",
            title: "buyer shortlist",
          },
        },
      ],
      requiredConcepts: [
        { label: "Jordan shortlist", allOf: ["Jordan", "buyer shortlist"] },
      ],
    }, JSON.stringify({
      actions: [
        {
          owner: "Jordan",
          title: "Jordan will not prepare the buyer shortlist",
        },
      ],
    }));

    expect(score.missingJsonMatches).toEqual(["Jordan shortlist action"]);
    expect(score.missingConcepts).toEqual(["Jordan shortlist"]);
    expect(score.passed).toBe(false);
  });

  it("matches concepts on token boundaries", () => {
    expect(conceptMatches(["45"], "RidgeWorks has 145 operators")).toBe(false);
    expect(conceptMatches(["45 operators"], "RidgeWorks has 145 operators")).toBe(false);
    expect(conceptMatches(["45 operators"], "RidgeWorks has 45 operators")).toBe(true);
  });

  it("retries transient fetch network failures", () => {
    expect(isRetryableRequestError(new TypeError("fetch failed"))).toBe(true);
  });

  it("includes retry time in reported evaluation latency", async () => {
    process.env.MODEL_API_KEY = "model-key";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "retry succeeded" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callCandidateWithRetries({
      label: "OpenAI rollback",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.openai.test/v1",
      authMode: "api_key",
      apiKeyEnv: "MODEL_API_KEY",
      maxTokenParameter: "max_tokens",
      scope: "https://cognitiveservices.azure.com/.default",
      temperature: 0,
    }, {
      id: "retry-case",
      flow: "retry behavior",
      prompt: "Retry once.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.retryCount).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(200);
    expect(result.finalAttemptLatencyMs).toBeLessThanOrEqual(result.latencyMs);
  });

  it("normalizes multipart candidate responses before scoring", async () => {
    process.env.MODEL_API_KEY = "model-key";
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{
        message: {
          content: [
            { type: "text", text: "{\"summary\":" },
            { type: "text", text: "\"Structured answer\"}" },
          ],
        },
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callCandidateWithRetries({
      label: "OpenAI rollback",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.openai.test/v1",
      authMode: "api_key",
      apiKeyEnv: "MODEL_API_KEY",
      maxTokenParameter: "max_tokens",
      scope: "https://cognitiveservices.azure.com/.default",
      temperature: 0,
    }, {
      id: "multipart-case",
      flow: "multipart response",
      prompt: "Return JSON.",
    });

    expect(result.text).toBe("{\"summary\":\n\"Structured answer\"}");
    expect(scoreItem({
      mode: "json",
      requiredKeys: ["summary"],
      requiredConcepts: ["Structured"],
    }, result.text).passed).toBe(true);
  });
});
