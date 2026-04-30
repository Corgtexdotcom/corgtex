import type { AgentTriggerType } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { executeAgentRun } from "../runtime";
import { prisma } from "@corgtex/shared";
import { executeWebSearch } from "../tools/web-search";
import { applyEnrichmentResult } from "@corgtex/domain";

export async function runCrmLeadEnrichmentAgent(params: {
  workspaceId: string;
  triggerRef: string;
  triggerType?: AgentTriggerType;
  payload: {
    eventId: string;
    aggregateId: string;
    email: string;
  };
}) {
  return executeAgentRun({
    agentKey: "crm-lead-enrichment",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Enrich a qualified CRM contact by searching the web and applying high-confidence data.",
    payload: params.payload,
    plan: ["load-contact", "web-search", "extract-and-score", "apply-enrichment"],
    buildContext: async (helpers) => {
      return helpers.step("load-contact", {}, async () => {
        const contact = await prisma.crmContact.findFirst({
          where: { workspaceId: params.workspaceId, email: params.payload.email },
        });

        if (!contact) {
          throw new Error("CrmContact not found.");
        }

        return { contact };
      });
    },
    execute: async (context, helpers, runId, model) => {
      const contact = context.contact as any;
      const domain = contact.email.split("@")[1];
      const companyHint = contact.company || domain;

      // Web Search
      const searchResult = await helpers.tool("web_search", { query: companyHint }, async () => {
        return executeWebSearch({
          workspaceId: params.workspaceId,
          agentRunId: runId,
          query: `"${companyHint}" company description, industry, headquarters`,
        });
      });

      // Extract & Score
      const extracted = await helpers.tool("model.extract", {}, async () => {
        const searchContext = searchResult.degraded 
          ? "Search degraded. Rely on parametric knowledge." 
          : JSON.stringify(searchResult.results);

        return defaultModelGateway.extract({
          model,
          workspaceId: params.workspaceId,
          agentRunId: runId,
          instruction: "Extract company profile data and provide a confidence score (0.0 to 1.0) for the extracted data based on the provided search results.",
          input: `Company hint: ${companyHint}. Search Context: ${searchContext}`,
          schemaHint: JSON.stringify({
            description: "string | null",
            industry: "string | null",
            headquarters: "string | null",
            confidence: "number",
          }),
        });
      });

      await helpers.step("apply-enrichment", {}, async () => {
        const enrichedData = extracted.output as {
          description?: string | null;
          industry?: string | null;
          headquarters?: string | null;
          confidence: number;
        };
        await applyEnrichmentResult(
          params.workspaceId,
          contact.id,
          enrichedData
        );
      });

      return {
        resultJson: {
          extractedData: extracted.output as any,
          searchUsed: !searchResult.degraded,
        },
      };
    },
  });
}
