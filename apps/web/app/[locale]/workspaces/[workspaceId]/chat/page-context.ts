export const OPEN_WORKSPACE_CHAT_EVENT = "corgtex:open-workspace-chat";

export type WorkspaceChatPageContext = {
  surface: "context-map";
  route: string;
  workspaceId: string;
  mapView: {
    id: string;
    name: string;
    viewType: string;
  };
  includeStale: boolean;
  selectedObjectIds: string[];
  selectedObjects: Array<{
    id: string;
    title: string;
    objectType: string;
    status: string;
  }>;
  selectedRelationship: {
    id: string;
    sourceObjectId: string;
    targetObjectId: string;
    relationshipType: string;
    status: string;
  } | null;
};

export type OpenWorkspaceChatEventDetail = {
  pageContext?: WorkspaceChatPageContext;
};

export function openWorkspaceChat(detail: OpenWorkspaceChatEventDetail) {
  window.dispatchEvent(new CustomEvent<OpenWorkspaceChatEventDetail>(OPEN_WORKSPACE_CHAT_EVENT, {
    detail,
  }));
}
