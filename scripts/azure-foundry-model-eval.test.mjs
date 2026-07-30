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
              title: { type: "string", minLength: 1 },
              owner: { type: "string", minLength: 1 },
              dueDate: { type: "string", minLength: 1 },
              evidence: { type: "string", minLength: 1 },
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

    const emptyEvidenceScore = scoreItem(item, "{\"actions\":[{\"title\":\"Buyer shortlist\",\"owner\":\"Jordan\",\"dueDate\":\"2026-08-03\",\"evidence\":\"\"}]}");
    expect(emptyEvidenceScore.schemaValid).toBe(false);
    expect(emptyEvidenceScore.invalidJsonShapes).toEqual([
      "actions[0].evidence must contain at least 1 non-whitespace character",
    ]);
    expect(emptyEvidenceScore.passed).toBe(false);

    const nestedScore = scoreItem(item, "{\"actions\":[{\"title\":\"Buyer shortlist\",\"owner\":\"Jordan\",\"dueDate\":\"2026-08-03\",\"evidence\":\"Notes\"}]}");
    expect(nestedScore.schemaValid).toBe(true);
    expect(nestedScore.invalidJsonShapes).toEqual([]);
  });

  it("rejects null placeholders for structured meeting summary sections", () => {
    const item = {
      mode: "json",
      requiredKeys: ["summary", "decisions", "actions", "risks"],
      requiredJsonShapes: {
        summary: { type: "string", minLength: 1 },
        decisions: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        actions: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        risks: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      },
      requiredJsonMatches: [
        {
          label: "meeting summary structured sections",
          path: "",
          fields: {
            decisions: {
              allOf: [
                "Barcelona pilot",
                ["proceed", "approved"],
                ["only if finance", "if finance", "finance confirms", "finance confirmation", "vendor cap", "contingent on finance"],
                ["no external announcement", "external announcement yet", "do not make an external announcement yet"],
              ],
            },
            actions: { allOf: ["Mina", "vendor cap", "Friday", "Support", ["two days", "2 days"]] },
            risks: { allOf: ["Data import", ["risk", "risky", "remains a risk", "may be affected"], ["duplicate company rows", "duplicate rows"]] },
          },
        },
      ],
      requiredConcepts: [
        { label: "Barcelona pilot", anyOf: ["Barcelona pilot"] },
        { label: "finance deadline", allOf: ["finance", "vendor cap", "Friday"] },
        { label: "Support notice", allOf: ["Support", ["two days", "2 days"]] },
        { label: "duplicate company rows", anyOf: ["duplicate company rows"] },
      ],
      forbiddenConcepts: [
        { label: "unconditional pilot approval", anyOf: ["unconditionally", "without finance confirmation", "regardless of finance", "no finance condition"] },
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

    const emptySummaryScore = scoreItem(
      item,
      "{\"summary\":\"\",\"decisions\":[\"Proceed with Barcelona pilot planning; no external announcement yet.\"],\"actions\":[\"Mina owns the finance vendor cap check by Friday and will include Support's two days of notice in the launch note.\"],\"risks\":[\"Data import remains risky because of duplicate company rows.\"]}",
    );
    expect(emptySummaryScore.schemaValid).toBe(false);
    expect(emptySummaryScore.invalidJsonShapes).toEqual([
      "summary must contain at least 1 non-whitespace character",
    ]);
    expect(emptySummaryScore.passed).toBe(false);

    const summaryOnlyScore = scoreItem(
      item,
      "{\"summary\":\"The Barcelona pilot can proceed if finance confirms the vendor cap by Friday. No external announcement yet. Mina owns the vendor cap and Support needs two days of notice. Data import remains a risk because of duplicate company rows.\",\"decisions\":[\"General decision\"],\"actions\":[\"General action\"],\"risks\":[\"General risk\"]}",
    );
    expect(summaryOnlyScore.schemaValid).toBe(true);
    expect(summaryOnlyScore.missingConcepts).toEqual([]);
    expect(summaryOnlyScore.missingJsonMatches).toEqual(["meeting summary structured sections"]);
    expect(summaryOnlyScore.passed).toBe(false);

    const unconditionalDecisionScore = scoreItem(
      item,
      "{\"summary\":\"Barcelona pilot planning is in scope.\",\"decisions\":[\"Proceed with Barcelona pilot planning unconditionally; no external announcement yet.\"],\"actions\":[\"Mina owns the finance vendor cap check by Friday and will include Support's two days of notice in the launch note.\"],\"risks\":[\"Data import remains risky because of duplicate company rows.\"]}",
    );
    expect(unconditionalDecisionScore.schemaValid).toBe(true);
    expect(unconditionalDecisionScore.missingJsonMatches).toEqual(["meeting summary structured sections"]);
    expect(unconditionalDecisionScore.forbiddenMentions).toEqual(["unconditional pilot approval"]);
    expect(unconditionalDecisionScore.passed).toBe(false);

    const matchedScore = scoreItem(
      item,
      "{\"summary\":\"Barcelona pilot planning is in scope.\",\"decisions\":[\"Proceed with Barcelona pilot planning only if finance confirms the vendor cap; no external announcement yet.\"],\"actions\":[\"Mina owns the finance vendor cap check by Friday and will include Support's two days of notice in the launch note.\"],\"risks\":[\"Data import remains risky because of duplicate company rows.\"]}",
    );
      expect(matchedScore.schemaValid).toBe(true);
      expect(matchedScore.missingJsonMatches).toEqual([]);
      expect(matchedScore.passed).toBe(true);

      const contingentWordingScore = scoreItem(
        item,
        "{\"summary\":\"The team will proceed with planning for the Barcelona pilot in August, contingent on finance confirming the vendor cap by Friday. No external announcement will be made yet. Support requires two days of notice, and duplicate company rows remain a data-import risk.\",\"decisions\":[\"Proceed with Barcelona pilot planning.\",\"Pilot approval is contingent on finance confirming the vendor cap by Friday.\",\"Do not make an external announcement yet.\"],\"actions\":[\"Mina will check the vendor cap by Friday.\",\"Include in the launch note that Support needs two days of notice.\"],\"risks\":[\"Data import may be affected by duplicate company rows in the spreadsheet template.\"]}",
      );
      expect(contingentWordingScore.schemaValid).toBe(true);
      expect(contingentWordingScore.missingJsonMatches).toEqual([]);
      expect(contingentWordingScore.passed).toBe(true);
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
              title: { type: "string", minLength: 1 },
              owner: { type: "string", minLength: 1 },
              dueDate: { type: "string", minLength: 1 },
              evidence: { type: "string", minLength: 1 },
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
            owner: { anyOf: ["Priya", "Legal"] },
            title: "DPA",
            dueDate: { anyOf: ["unknown", "no due date", "not provided", "no date"] },
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

    const inventedDateScore = scoreItem(item, JSON.stringify({
      actions: [
        { title: "Prepare buyer shortlist", owner: "Jordan", dueDate: "2026-08-03", evidence: "Jordan will prepare the buyer shortlist" },
        { title: "DPA approval blocker", owner: "Priya", dueDate: "2026-08-04", evidence: "Waiting on legal to approve the DPA" },
      ],
    }));
    expect(inventedDateScore.schemaValid).toBe(true);
    expect(inventedDateScore.missingJsonMatches).toEqual(["Priya DPA blocker action"]);
    expect(inventedDateScore.passed).toBe(false);

    const matchedScore = scoreItem(item, JSON.stringify({
      actions: [
        { title: "Prepare buyer shortlist", owner: "Jordan", dueDate: "2026-08-03", evidence: "Jordan will prepare the buyer shortlist" },
        { title: "DPA approval blocker", owner: "Priya", dueDate: "unknown", evidence: "Waiting on legal to approve the DPA" },
      ],
    }));
      expect(matchedScore.missingJsonMatches).toEqual([]);
      expect(matchedScore.passed).toBe(true);

      const delegatedOwnerScore = scoreItem(item, JSON.stringify({
        actions: [
          { title: "Prepare buyer shortlist", owner: "Jordan", dueDate: "2026-08-03", evidence: "Jordan will prepare the buyer shortlist" },
          { title: "Approve the DPA before any data import", owner: "Legal", dueDate: "unknown", evidence: "Priya is waiting on legal to approve the DPA before any data import" },
        ],
      }));
      expect(delegatedOwnerScore.missingJsonMatches).toEqual([]);
      expect(delegatedOwnerScore.passed).toBe(true);
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
            need: { allOf: ["governed AI workspace", "45 operators"] },
            timeline: { anyOf: ["September pilot", "September"] },
            followUp: { allOf: [["security docs", "security documents", "security documentation"], "pricing overview"] },
          },
        },
      ],
      requiredConcepts: [
        "RidgeWorks",
        "Elena",
        "45 operators",
        "procurement approval",
        "September pilot",
        { label: "security docs", anyOf: ["security docs", "security documents", "security documentation"] },
        "pricing overview",
      ],
      forbiddenConcepts: [
        {
          label: "procurement approval completed",
          anyOf: [
            "procurement approval received",
            "procurement approval obtained",
            "approval received",
            "approval obtained",
            "procurement approved",
          ],
        },
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

    const completedApprovalScore = scoreItem(item, JSON.stringify({
      company: "RidgeWorks",
      contact: "Elena",
      need: "Governed AI workspace for 45 operators; procurement approval received",
      timeline: "September pilot",
      followUp: "Send security docs and a short pricing overview",
    }));
    expect(completedApprovalScore.schemaValid).toBe(true);
    expect(completedApprovalScore.missingJsonMatches).toEqual([]);
    expect(completedApprovalScore.forbiddenMentions).toEqual(["procurement approval completed"]);
    expect(completedApprovalScore.passed).toBe(false);

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

    const documentsWordingScore = scoreItem(item, JSON.stringify({
      company: "RidgeWorks",
      contact: "Elena",
      need: "Governed AI workspace for 45 operators",
      timeline: "Procurement approval is needed before a September pilot",
      followUp: "Send security documents and a short pricing overview",
    }));
    expect(documentsWordingScore.schemaValid).toBe(true);
    expect(documentsWordingScore.missingJsonMatches).toEqual([]);
    expect(documentsWordingScore.passed).toBe(true);
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
                ["approval controls", "approval", "approvals", "review", "review controls", "prevented", "prevent", "preventing"],
                ["before any draft leaves", "before approval", "before sending", "send", "sending", "sends"],
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

      const preventionWordingScore = scoreItem(
        item,
        "Intent: Enable the CRM follow-up assistant for the internal workspace to support drafting follow-up emails.\nScope: The assistant may draft emails only. It may not send emails.\nObjections to test:\n- Whether drafts remain limited to the internal workspace.\n- Whether the assistant can be prevented from sending emails.\n- Whether ten sampled drafts are sufficient for review.\nNext review date: 2026-08-15, after ten sampled drafts.",
      );
      expect(preventionWordingScore.missingConcepts).toEqual([]);
      expect(preventionWordingScore.missingTextSections).toEqual([]);
      expect(preventionWordingScore.passed).toBe(true);

      const beforeApprovalScore = scoreItem(
        item,
        "Intent: Enable CRM follow-up drafting for the internal workspace only.\nScope: The assistant may draft emails but cannot send them.\nObjections to test:\n- Whether review controls prevent draft emails from being sent before approval.\nNext review date: 2026-08-15 after ten sampled drafts.",
      );
      expect(beforeApprovalScore.missingConcepts).toEqual([]);
      expect(beforeApprovalScore.missingTextSections).toEqual([]);
      expect(beforeApprovalScore.passed).toBe(true);
  });

  it("requires Brain open questions and confidence to be usable fields", () => {
    const item = {
      mode: "json",
      requiredKeys: ["companyFacts", "openQuestions", "confidence"],
      requiredJsonShapes: {
        companyFacts: { type: "array", minItems: 1, items: { type: "string" } },
        openQuestions: { type: "array", minItems: 1, items: { type: "string" } },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
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
                ["measure", "measured", "metric", "metrics", "target", "targets"],
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

    const invalidConfidenceScore = scoreItem(item, JSON.stringify({
      companyFacts: [
        "Northstar Components runs two plants in Ohio.",
        "It serves medical-device manufacturers.",
        "Its 2026 priority is reducing lead-time variance.",
        "The Mexico warehouse is not approved.",
      ],
      openQuestions: ["What metric will measure lead-time variance reduction?"],
      confidence: "medium-high",
    }));
    expect(invalidConfidenceScore.schemaValid).toBe(false);
    expect(invalidConfidenceScore.invalidJsonShapes).toEqual([
      "confidence must be one of low, medium, high",
    ]);
    expect(invalidConfidenceScore.passed).toBe(false);

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

      const measuredWordingScore = scoreItem(item, JSON.stringify({
        companyFacts: [
          "Northstar Components runs two plants in Ohio.",
          "Northstar Components serves medical-device manufacturers.",
          "Northstar Components' 2026 priority is reducing supplier lead-time variance.",
          "A draft memo says the team is considering a Mexico warehouse, but it is not approved.",
        ],
        openQuestions: [
          "How will progress on reducing supplier lead-time variance be measured?",
          "What targets or thresholds will define success for the 2026 priority?",
        ],
        confidence: "medium",
      }));
      expect(measuredWordingScore.schemaValid).toBe(true);
      expect(measuredWordingScore.missingJsonMatches).toEqual([]);
      expect(measuredWordingScore.passed).toBe(true);
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
        {
          label: "FYI section",
          heading: { anyOf: ["FYI", "notes", "updates"] },
          concepts: [{ label: "Finance to Ledger staging FYI", allOf: [["Finance tab", "Finance"], "Ledger"] }],
        },
      ],
      requiredConcepts: [
        "onboarding checklist",
        "Niko",
        "tomorrow",
        { label: "Slack missing scope risk", allOf: ["Slack ingestion", "missing scope"] },
        { label: "Finance to Ledger staging FYI", allOf: [["Finance tab", "Finance"], "Ledger"] },
      ],
    };

    const unstructuredScore = scoreItem(
      item,
      "The governance circle accepted the onboarding checklist update; Niko will publish it tomorrow; Slack ingestion failed because of a missing scope.",
    );
    expect(unstructuredScore.missingConcepts).toEqual(["Finance to Ledger staging FYI"]);
    expect(unstructuredScore.missingTextSections).toEqual([
      "decisions section",
      "actions section",
      "risks section",
      "FYI section",
    ]);
    expect(unstructuredScore.passed).toBe(false);

    const misplacedScore = scoreItem(
      item,
      "Decisions:\n- The governance circle accepted the onboarding checklist update.\nActions:\n- Niko will publish the checklist tomorrow.\nRisks:\n- No risks mentioned.",
    );
    expect(misplacedScore.missingTextSections).toEqual(["risks section", "FYI section"]);
    expect(misplacedScore.passed).toBe(false);

    const matchedScore = scoreItem(
      item,
      "Decisions: The governance circle accepted the onboarding checklist update.\nActions:\n- Niko will publish the checklist tomorrow.\nRisks:\n- Slack ingestion failed for one private channel due to missing scope.\nFYI:\n- The Finance tab was renamed to Ledger in staging.",
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
                ["not send", "cannot send", "do not send", "not yet", "wait", "do not email", "don't email", "don't send", "hold off"],
                ["unreconciled cost numbers", "cost numbers are still unreconciled", "cost numbers still unreconciled", "cost numbers are unreconciled", "cost numbers still need to be reconciled", "cost numbers need to be reconciled", "reconcile the cost numbers"],
                ["account owner", "not been approved by the account owner", "account owner has not approved", "account owner approval"],
                ["approval", "approved", "not approved", "not been approved", "not yet been approved", "has not approved", "obtain approval"],
              ],
            },
          },
        },
      ],
      requiredConcepts: [
        { label: "approval needed", allOf: [["approval", "approved", "not approved", "not been approved", "not yet been approved", "has not approved", "obtain approval"], ["account owner", "not been approved by the account owner", "account owner has not approved", "account owner approval"]] },
        { label: "cost numbers risk", allOf: ["cost numbers", ["unreconciled", "need to be reconciled", "needs to be reconciled", "still need to be reconciled", "reconcile"]] },
        { label: "unsafe to send", anyOf: ["not send", "cannot send", "do not send", "not yet", "wait", "do not email", "don't email", "don't send", "hold off"] },
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

    const causalNegationScore = scoreItem(item, JSON.stringify({
      replyNeeded: true,
      proposedReply: "Do not send because the unreconciled cost numbers need account owner approval.",
      unsafeToSend: true,
    }));
    expect(causalNegationScore.schemaValid).toBe(true);
      expect(causalNegationScore.missingJsonMatches).toEqual([]);
      expect(causalNegationScore.missingConcepts).toEqual([]);
      expect(causalNegationScore.passed).toBe(true);

      const notYetWordingScore = scoreItem(item, JSON.stringify({
        replyNeeded: true,
        proposedReply: "Not yet - the draft migration plan contains unreconciled cost numbers and has not been approved by the account owner. Please reconcile the costs and obtain approval before emailing it to the customer.",
        unsafeToSend: true,
      }));
      expect(notYetWordingScore.schemaValid).toBe(true);
      expect(notYetWordingScore.missingJsonMatches).toEqual([]);
      expect(notYetWordingScore.missingConcepts).toEqual([]);
      expect(notYetWordingScore.passed).toBe(true);

      const waitWordingScore = scoreItem(item, JSON.stringify({
        replyNeeded: true,
        proposedReply: "Wait to send the plan. The unreconciled cost numbers still need account owner approval before it goes to the customer.",
        unsafeToSend: true,
      }));
      expect(waitWordingScore.schemaValid).toBe(true);
      expect(waitWordingScore.missingJsonMatches).toEqual([]);
      expect(waitWordingScore.missingConcepts).toEqual([]);
      expect(waitWordingScore.passed).toBe(true);

      const smartApostropheScore = scoreItem(item, JSON.stringify({
        replyNeeded: true,
        proposedReply: "Please don\u2019t email the draft migration plan yet. The cost numbers still need to be reconciled, and the account owner has not approved the plan.",
        unsafeToSend: true,
      }));
      expect(smartApostropheScore.schemaValid).toBe(true);
      expect(smartApostropheScore.missingJsonMatches).toEqual([]);
      expect(smartApostropheScore.missingConcepts).toEqual([]);
      expect(smartApostropheScore.passed).toBe(true);

      const unreconciledStateScore = scoreItem(item, JSON.stringify({
        replyNeeded: true,
        proposedReply: "Sam, please don\u2019t email the draft migration plan to the customer yet. The cost numbers are still unreconciled, and the plan has not been approved by the account owner.",
        unsafeToSend: true,
      }));
      expect(unreconciledStateScore.schemaValid).toBe(true);
      expect(unreconciledStateScore.missingJsonMatches).toEqual([]);
      expect(unreconciledStateScore.missingConcepts).toEqual([]);
      expect(unreconciledStateScore.passed).toBe(true);

      const notYetApprovedScore = scoreItem(item, JSON.stringify({
        replyNeeded: true,
        proposedReply: "Sam, please do not send the draft migration plan to the customer today. The cost numbers are still unreconciled, and the plan has not yet been approved by the account owner.",
        unsafeToSend: true,
      }));
      expect(notYetApprovedScore.schemaValid).toBe(true);
      expect(notYetApprovedScore.missingJsonMatches).toEqual([]);
      expect(notYetApprovedScore.missingConcepts).toEqual([]);
      expect(notYetApprovedScore.passed).toBe(true);
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

  it.each([
    "https://api.openai.com/v1?api-version=bad",
    "https://api.openai.com/v1#fragment",
    "https://user:pass@api.openai.com/v1",
    "https://api.openai.com:444/v1",
  ])("rejects query or fragment components in evaluation candidate base URLs: %s", (baseUrl) => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "OpenAI rollback",
        provider: "openai",
        model: "gpt-4o",
        baseUrl,
      },
    ]);

    expect(() => parseCandidates()).toThrow("AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[0].baseUrl must be an HTTPS URL without query or fragment");
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

    expect(() => parseCandidates()).toThrow("baseUrl must be a trusted Azure OpenAI-compatible /openai/v1 URL for managed identity");
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

    expect(() => parseCandidates()).toThrow("baseUrl must be a trusted Azure OpenAI-compatible /openai/v1 URL for API key");
  });

  it.each([
    "https://corgtex-foundry-models-wus3.services.ai.azure.com/openai",
    "https://corgtex-foundry-models-wus3.services.ai.azure.com/openai/v2",
    "https://corgtex-foundry-models-wus3.services.ai.azure.com/openai/v1?api-version=2026-07-29",
    "https://user:pass@corgtex-foundry-models-wus3.services.ai.azure.com/openai/v1",
    "https://corgtex-foundry-models-wus3.services.ai.azure.com:444/openai/v1",
  ])("rejects Azure evaluation candidates without an exact /openai/v1 base path: %s", (baseUrl) => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "Foundry candidate",
        provider: "azure-foundry",
        model: "corgtex-gpt56-luna",
        baseUrl,
        authMode: "api_key",
      },
    ]);

    const expectedError = baseUrl.includes("?") || baseUrl.includes("@") || baseUrl.includes(":444")
      ? "AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[0].baseUrl must be an HTTPS URL without query or fragment"
      : "baseUrl must be a trusted Azure OpenAI-compatible /openai/v1 URL for API key";
    expect(() => parseCandidates()).toThrow(expectedError);
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
