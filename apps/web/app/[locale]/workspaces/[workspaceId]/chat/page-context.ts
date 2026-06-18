export const OPEN_WORKSPACE_CHAT_EVENT = "corgtex:open-workspace-chat";
export const SET_WORKSPACE_CHAT_PAGE_CONTEXT_EVENT = "corgtex:set-workspace-chat-page-context";

export type WorkspaceChatContextMapPageContext = {
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

export type WorkspaceChatCrmPageContext = {
  surface: "crm";
  route: string;
  workspaceId: string;
  view: string;
  section?: string | null;
  selectedIds?: {
    accountId?: string | null;
    contactId?: string | null;
    dealId?: string | null;
    activityId?: string | null;
    suggestionId?: string | null;
  };
  filters?: Record<string, string | number | boolean | null | undefined>;
  pagination?: {
    page?: number;
    pageCount?: number;
    total?: number;
  };
  visibleContext?: {
    metrics?: Array<{ label: string; value: string; detail?: string | null }>;
    accounts?: Array<{
      id: string;
      name: string;
      domain?: string | null;
      relationshipType?: string | null;
      lifecycleStage?: string | null;
      webUrl?: string | null;
    }>;
    contacts?: Array<{
      id: string;
      name?: string | null;
      email?: string | null;
      title?: string | null;
      accountId?: string | null;
      accountName?: string | null;
      webUrl?: string | null;
    }>;
    deals?: Array<{
      id: string;
      title: string;
      stage?: string | null;
      accountId?: string | null;
      accountName?: string | null;
      contactId?: string | null;
      contactName?: string | null;
      valueCents?: number | null;
      ownerUserId?: string | null;
      webUrl?: string | null;
    }>;
    activities?: Array<{
      id: string;
      title: string;
      type?: string | null;
      accountId?: string | null;
      accountName?: string | null;
      contactId?: string | null;
      contactName?: string | null;
      dealId?: string | null;
      dealTitle?: string | null;
      dueAt?: string | null;
      completedAt?: string | null;
      ownerUserId?: string | null;
      webUrl?: string | null;
    }>;
    suggestions?: Array<{
      id: string;
      title: string;
      status?: string | null;
      accountId?: string | null;
      accountName?: string | null;
      contactId?: string | null;
      contactName?: string | null;
      dealId?: string | null;
      dealTitle?: string | null;
      recipientEmail?: string | null;
      subject?: string | null;
      webUrl?: string | null;
    }>;
  };
};

export type WorkspaceChatPageContext = WorkspaceChatContextMapPageContext | WorkspaceChatCrmPageContext;

export type OpenWorkspaceChatEventDetail = {
  pageContext?: WorkspaceChatPageContext;
};

export type SetWorkspaceChatPageContextEventDetail = {
  pageContext?: WorkspaceChatPageContext | null;
};

declare global {
  interface Window {
    __corgtexWorkspaceChatPageContext?: WorkspaceChatPageContext | null;
  }
}

export function openWorkspaceChat(detail: OpenWorkspaceChatEventDetail) {
  window.__corgtexWorkspaceChatPageContext = detail.pageContext ?? null;
  window.dispatchEvent(new CustomEvent<OpenWorkspaceChatEventDetail>(OPEN_WORKSPACE_CHAT_EVENT, {
    detail,
  }));
}

export function setWorkspaceChatPageContext(detail: SetWorkspaceChatPageContextEventDetail) {
  window.__corgtexWorkspaceChatPageContext = detail.pageContext ?? null;
  window.dispatchEvent(new CustomEvent<SetWorkspaceChatPageContextEventDetail>(SET_WORKSPACE_CHAT_PAGE_CONTEXT_EVENT, {
    detail,
  }));
}
