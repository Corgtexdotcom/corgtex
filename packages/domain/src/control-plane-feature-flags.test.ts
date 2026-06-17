import { describe, expect, it } from "vitest";

import { CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS } from "./control-plane";

/**
 * `CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS` is derived from the Module Manifest
 * registry. This test pins the derived output to the intended list: order,
 * labels, descriptions, and defaults.
 */
const EXPECTED = [
  { flag: "GOALS", label: "Goals", description: "Goal trees, recognition, and progress tracking.", defaultEnabled: true },
  { flag: "TOOL_LINKS", label: "Tools catalog", description: "Shared tool links, catalog approvals, and credentials.", defaultEnabled: false },
  { flag: "FINANCE", label: "Finance", description: "Spend requests, ledgers, and finance workflows.", defaultEnabled: true },
  { flag: "BUILD_ARTIFACTS", label: "Build artifacts", description: "Workspace build artifact publishing and review.", defaultEnabled: false },
  { flag: "RELATIONSHIPS", label: "Relationships", description: "CRM, leads, and relationship workspace views.", defaultEnabled: true },
  { flag: "CONTEXT_MAPS", label: "Context maps", description: "Living company context graph maps, graph evidence, and region-scoped agent context.", defaultEnabled: false },
  { flag: "CYCLES", label: "Cycles", description: "Planning cycles, updates, and allocations.", defaultEnabled: true },
  { flag: "AGENT_GOVERNANCE", label: "Agent governance", description: "Agent registry, access, spend, and observability controls.", defaultEnabled: true },
  { flag: "OS_METRICS", label: "OS metrics", description: "Governance health and operating-system metrics.", defaultEnabled: true },
  { flag: "SETTINGS_GENERAL", label: "General settings", description: "General workspace configuration screens.", defaultEnabled: true },
  { flag: "MULTILINGUAL", label: "Multilingual", description: "Locale switcher and translated workspace UI.", defaultEnabled: false },
  { flag: "MEETING_TRANSCRIPT_SOURCES", label: "Meeting transcript sources", description: "Import transcripts from existing meeting recorders and upload exports.", defaultEnabled: false },
  { flag: "MEETING_RECORDERS", label: "Meeting recorders", description: "Managed meeting recorder entitlement and recorder config.", defaultEnabled: false },
  { flag: "MEETING_CONTEXTUAL_INTELLIGENCE", label: "Context-aware meeting intelligence", description: "Use workspace context to summarize meetings and automatically update related governance records.", defaultEnabled: false },
  { flag: "CONTEXT_MAP_AI", label: "Context map AI", description: "Premium chat tools for reading, reasoning about, and applying living context map graph changes.", defaultEnabled: false },
  { flag: "SLACK_MEETING_ACTION_REVIEW", label: "Slack meeting action review", description: "Post meeting summaries and proposed action-item follow-ups to an approved Slack review surface before action creation.", defaultEnabled: false },
  { flag: "AI_WORKSPACES", label: "AI workspaces", description: "Catalog and setup foundation for OpenWork, ChatGPT, Claude, GitHub Copilot, Gemini, Cursor, and generic MCP clients.", defaultEnabled: true },
  { flag: "OPENWORK_DEFAULT", label: "OpenWork default", description: "Recommend OpenWork as the default free self-managed AI workspace.", defaultEnabled: false },
  { flag: "EXECUTION_PACKETS", label: "Execution packets", description: "Durable execution request, context packet, and result write-back plumbing.", defaultEnabled: false },
  { flag: "MANAGED_ENTERPRISE_SERVICES", label: "Managed enterprise services", description: "CORGTEX-managed service ownership, health, usage, and support escalation foundation.", defaultEnabled: false },
  { flag: "PRACTICE_PROJECTS", label: "Practice projects", description: "Consulting project portfolio: budgets, burn, remaining, and margin tracking with an attention queue.", defaultEnabled: false },
];

describe("CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS (registry-derived)", () => {
  it("matches the prior hand-written list exactly", () => {
    expect(CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((entry) => ({
      flag: entry.flag,
      label: entry.label,
      description: entry.description,
      defaultEnabled: entry.defaultEnabled,
    }))).toEqual(EXPECTED);
  });
});
