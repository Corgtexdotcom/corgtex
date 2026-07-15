import { describe, expect, it } from "vitest";
import { evaluateDelegatedActionPolicy, isSensitiveDelegatedAction } from "./action-policy";

describe("delegated action policy", () => {
  it("auto-runs scoped reads", () => {
    expect(evaluateDelegatedActionPolicy({
      toolName: "search_connected_context",
      operation: "read",
    })).toMatchObject({
      policyClass: "read",
      autoRunAllowed: true,
      requiresSensitiveHandling: false,
    });
  });

  it("auto-runs normal writes for explicit user intent or high confidence", () => {
    expect(evaluateDelegatedActionPolicy({
      toolName: "create_action",
      operation: "write",
      explicitUserIntent: true,
      confidence: 0.4,
    })).toMatchObject({
      policyClass: "normal_write",
      autoRunAllowed: true,
    });

    expect(evaluateDelegatedActionPolicy({
      toolName: "create_action",
      operation: "write",
      confidence: 0.91,
    })).toMatchObject({
      policyClass: "normal_write",
      autoRunAllowed: true,
    });
  });

  it("drafts or clarifies medium and low confidence normal writes", () => {
    expect(evaluateDelegatedActionPolicy({
      toolName: "create_action",
      operation: "write",
      confidence: 0.7,
    })).toMatchObject({
      policyClass: "draft_or_clarify",
      autoRunAllowed: false,
      requiresSensitiveHandling: false,
    });

    expect(evaluateDelegatedActionPolicy({
      toolName: "create_action",
      operation: "write",
      confidence: 0.2,
    })).toMatchObject({
      policyClass: "draft_or_clarify",
      autoRunAllowed: false,
      requiresSensitiveHandling: false,
    });
  });

  it("treats reversible archives and normal product writes as non-sensitive", () => {
    for (const toolName of [
      "archive_proposal",
      "delete_action",
      "create_member",
      "update_member",
      "upsert_tool_link",
      "upload_meeting",
      "create_goal",
      "create_article",
    ]) {
      expect(isSensitiveDelegatedAction(toolName), toolName).toBe(false);
      expect(evaluateDelegatedActionPolicy({
        toolName,
        operation: "write",
        explicitUserIntent: true,
      })).toMatchObject({
        policyClass: "normal_write",
        autoRunAllowed: true,
        requiresSensitiveHandling: false,
      });
    }
  });

  it("keeps credential reveal and support control-plane mutations sensitive", () => {
    for (const toolName of [
      "reveal_tool_link_credential",
      "set_feature_flag",
      "set_meeting_series_recorder_url",
      "set_meeting_recorder_auto_recording",
      "ensure_meeting_recorder_coverage",
      "record_support_audit",
      "support_reopen_resolved_proposals",
      "update_agent_policy",
      "update_model_budget",
      "revoke_agent_credential",
    ]) {
      expect(isSensitiveDelegatedAction(toolName), toolName).toBe(true);
      expect(evaluateDelegatedActionPolicy({
        toolName,
        operation: "write",
        explicitUserIntent: true,
      })).toMatchObject({
        policyClass: "sensitive",
        autoRunAllowed: false,
        requiresSensitiveHandling: true,
      });
    }
  });
});
