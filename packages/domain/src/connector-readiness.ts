export const CONNECTOR_AVAILABILITIES = ["LIVE", "PILOT_READY", "ON_REQUEST", "MANUAL_ONLY", "RESEARCH"] as const;

export type ConnectorAvailability = typeof CONNECTOR_AVAILABILITIES[number];

export type ConnectorReadinessProfile = {
  key: string;
  title: string;
  availability: ConnectorAvailability;
  connectMethod: "native_oauth" | "workspace_app" | "external_mcp" | "ai_client" | "app_runtime" | "manual_import" | "shared_link";
  connectorRole: "communication" | "documents" | "knowledge" | "whiteboard" | "ai_workspace" | "meeting_evidence" | "app" | "crm" | "project_management" | "design";
  connectedBy: "Workspace admin" | "User OAuth" | "Admin enables, users connect" | "Corgtex managed" | "Manual import";
  supportedOperations: string[];
  storagePolicy: string;
  sourceUrl?: string;
  adminNotes: string;
  recommended?: boolean;
  recommendationRank: number;
};

const CONNECTOR_READINESS_PROFILES: Record<string, ConnectorReadinessProfile> = {
  slack: {
    key: "slack",
    title: "Slack",
    availability: "LIVE",
    connectMethod: "workspace_app",
    connectorRole: "communication",
    connectedBy: "Workspace admin",
    supportedOperations: ["Public channel archive", "Commands", "App Home brief", "Message capture"],
    storagePolicy: "Public-channel messages can be indexed and summarized. Private channels and DMs stay out of scope.",
    adminNotes: "Requires the configured Corgtex Slack app and workspace admin installation.",
    recommendationRank: 10,
  },
  google: {
    key: "google",
    title: "Google Workspace",
    availability: "LIVE",
    connectMethod: "native_oauth",
    connectorRole: "documents",
    connectedBy: "User OAuth",
    supportedOperations: ["Calendar sync", "Selected Drive documents"],
    storagePolicy: "Calendar sync is read-only by default. Drive ingestion should use selected files, not broad Drive access.",
    adminNotes: "OAuth credentials must be configured and Google verification/test-user policy may gate access.",
    recommendationRank: 20,
  },
  microsoft: {
    key: "microsoft",
    title: "Microsoft 365",
    availability: "LIVE",
    connectMethod: "native_oauth",
    connectorRole: "documents",
    connectedBy: "User OAuth",
    supportedOperations: ["Outlook calendar sync", "Selected OneDrive and SharePoint files"],
    storagePolicy: "Calendar sync is read-only by default. Documents stay selected/source-filtered before ingestion.",
    adminNotes: "External tenants may require publisher verification or admin consent.",
    recommendationRank: 30,
  },
  "corgtex-mcp": {
    key: "corgtex-mcp",
    title: "Corgtex MCP",
    availability: "LIVE",
    connectMethod: "ai_client",
    connectorRole: "ai_workspace",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["Workspace context", "Brain search", "Governed write-back"],
    storagePolicy: "Corgtex remains the governed context and action layer for approved AI clients.",
    adminNotes: "Use the Corgtex MCP setup page instead of treating this as an external data source.",
    recommendationRank: 40,
  },
  "meeting-recorder": {
    key: "meeting-recorder",
    title: "Meeting transcripts",
    availability: "LIVE",
    connectMethod: "manual_import",
    connectorRole: "meeting_evidence",
    connectedBy: "Workspace admin",
    supportedOperations: ["Transcript source webhooks", "Transcript export upload", "Managed recorder configuration"],
    storagePolicy: "Meeting evidence is processed into proposals, actions, and Brain context with source provenance.",
    adminNotes: "Transcript import uses existing recorder exports first. Managed recorder access remains a separate entitlement.",
    recommendationRank: 50,
  },
  box: {
    key: "box",
    title: "Box",
    availability: "PILOT_READY",
    connectMethod: "external_mcp",
    connectorRole: "documents",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["Search", "Fetch file context", "Box AI tools"],
    storagePolicy: "Read/search/fetch first. Writes stay disabled until customer policy and approval are explicit.",
    sourceUrl: "https://developer.box.com/guides/box-mcp/",
    adminNotes: "Official hosted Box MCP exists; Corgtex still needs admin/OAuth product setup before exposing Connect.",
    recommended: true,
    recommendationRank: 70,
  },
  notion: {
    key: "notion",
    title: "Notion",
    availability: "PILOT_READY",
    connectMethod: "external_mcp",
    connectorRole: "knowledge",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["Search", "Fetch page context"],
    storagePolicy: "Live external context stays delegated to the user unless explicitly ingested later.",
    sourceUrl: "https://developers.notion.com/guides/mcp/overview",
    adminNotes: "Corgtex has an external-MCP scaffold, but the user-facing OAuth setup is not complete.",
    recommended: true,
    recommendationRank: 80,
  },
  atlassian: {
    key: "atlassian",
    title: "Atlassian",
    availability: "PILOT_READY",
    connectMethod: "external_mcp",
    connectorRole: "project_management",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["Jira search", "Confluence search", "Issue/page fetch"],
    storagePolicy: "Respect existing Atlassian permissions; writes require explicit Corgtex approval policy.",
    sourceUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    adminNotes: "Useful for Jira/Confluence customers, but Atlassian site/admin authorization is required.",
    recommended: true,
    recommendationRank: 90,
  },
  miro: {
    key: "miro",
    title: "Miro",
    availability: "ON_REQUEST",
    connectMethod: "external_mcp",
    connectorRole: "whiteboard",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["Board context", "Diagram generation", "Code handoff from boards"],
    storagePolicy: "Treat as live visual collaboration context, not durable knowledge sync by default.",
    sourceUrl: "https://developers.miro.com/changelog/its-here-the-miro-mcp-server-is-now-in-public-beta",
    adminNotes: "Public beta with Enterprise admin enablement; show as request-only.",
    recommendationRank: 110,
  },
  dropbox: {
    key: "dropbox",
    title: "Dropbox",
    availability: "ON_REQUEST",
    connectMethod: "external_mcp",
    connectorRole: "documents",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["List folders", "Search", "Fetch file content"],
    storagePolicy: "Read/search/fetch first; file mutations need separate approval.",
    adminNotes: "Official MCP exists, but Box is the preferred client-file priority for now.",
    recommendationRank: 120,
  },
  linear: {
    key: "linear",
    title: "Linear",
    availability: "ON_REQUEST",
    connectMethod: "external_mcp",
    connectorRole: "project_management",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["Issue search", "Issue fetch", "Project context"],
    storagePolicy: "Use delegated live context first; writes need explicit action policy.",
    adminNotes: "Available when a customer already runs product work in Linear.",
    recommendationRank: 130,
  },
  hubspot: {
    key: "hubspot",
    title: "HubSpot",
    availability: "ON_REQUEST",
    connectMethod: "external_mcp",
    connectorRole: "crm",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["CRM search", "Contact/company/deal context"],
    storagePolicy: "CRM writes stay disabled until a customer-specific approval and audit model exists.",
    adminNotes: "Official MCP exists, but CRM scope is high blast-radius and should remain request-only.",
    recommendationRank: 140,
  },
  figma: {
    key: "figma",
    title: "Figma",
    availability: "ON_REQUEST",
    connectMethod: "external_mcp",
    connectorRole: "design",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["Design context", "Canvas write-back", "Code generation context"],
    storagePolicy: "Use for design-to-code workflows, not general company knowledge ingestion.",
    adminNotes: "Keep request-only unless the workspace has a design-system implementation need.",
    recommendationRank: 150,
  },
  salesforce: {
    key: "salesforce",
    title: "Salesforce",
    availability: "RESEARCH",
    connectMethod: "external_mcp",
    connectorRole: "crm",
    connectedBy: "Admin enables, users connect",
    supportedOperations: ["CRM metadata", "Agentforce/Salesforce context"],
    storagePolicy: "Enterprise CRM data requires a customer-specific security and write policy before connection.",
    adminNotes: "Official MCP solutions exist, but this should wait for explicit customer pull.",
    recommendationRank: 160,
  },
};

export function connectorReadinessProfile(key: string) {
  return CONNECTOR_READINESS_PROFILES[key] ?? null;
}

export function listConnectorReadinessProfiles() {
  return Object.values(CONNECTOR_READINESS_PROFILES)
    .sort((a, b) => a.recommendationRank - b.recommendationRank || a.title.localeCompare(b.title));
}

export function connectorReadinessManifest(key: string) {
  const profile = connectorReadinessProfile(key);
  return profile ? { connectorReadiness: { sourceUrl: "", recommended: false, ...profile } } : {};
}
