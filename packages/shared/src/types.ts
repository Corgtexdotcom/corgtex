import type { GlobalRole, MemberRole, User } from "@prisma/client";

export type HumanActor = {
  kind: "user";
  user: Pick<User, "id" | "email" | "displayName"> & {
    globalRole?: GlobalRole;
  };
};

export type AgentActor = {
  kind: "agent";
  authProvider: "bootstrap" | "credential";
  label: string;
  credentialId?: string;
  workspaceIds?: string[];
  scopes?: string[];
  agentIdentityId?: string;
};

export type AppActor = HumanActor | AgentActor;

export type MembershipSummary = {
  id: string;
  workspaceId: string;
  userId: string;
  role: MemberRole;
  isActive: boolean;
};
