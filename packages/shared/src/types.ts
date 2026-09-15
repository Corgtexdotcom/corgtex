import type { GlobalRole, MemberRole, User } from "@prisma/client";

export type HumanActor = {
  kind: "user";
  user: Pick<User, "id" | "email" | "displayName"> & {
    globalRole?: GlobalRole;
    isSupportAccount?: boolean;
  };
};

export type AgentActor = {
  kind: "agent";
  authProvider: "bootstrap" | "credential" | "control-plane";
  label: string;
  credentialId?: string;
  catalogItemId?: string | null;
  workspaceIds?: string[];
  scopes?: string[];
  agentIdentityId?: string;
  supportOrigin?: { userId: string; workspaceId: string; version: number };
};

export type AppActor = HumanActor | AgentActor;

export type MembershipSummary = {
  id: string;
  workspaceId: string;
  userId: string;
  role: MemberRole;
  isActive: boolean;
};
