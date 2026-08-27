import type { MemberKind, Prisma } from "@prisma/client";

type MemberIdentityUser = {
  email?: string | null;
  displayName?: string | null;
};

export type MemberIdentityInput = {
  kind?: MemberKind | null;
  user?: MemberIdentityUser | null;
  email?: string | null;
  displayName?: string | null;
} | null | undefined;

const SYSTEM_EMAIL_PREFIXES = ["system+", "support+"];
const SYSTEM_DISPLAY_NAMES = new Set(["corgtex support"]);

function normalized(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function identityUser(input: MemberIdentityInput): MemberIdentityUser {
  if (!input) return {};
  if ("user" in input && input.user) return input.user;
  return input;
}

export function inferMemberKindFromUserIdentity(user: MemberIdentityUser): MemberKind {
  const email = normalized(user.email);
  const displayName = normalized(user.displayName);
  if (SYSTEM_EMAIL_PREFIXES.some((prefix) => email.startsWith(prefix))) return "SYSTEM";
  if (SYSTEM_DISPLAY_NAMES.has(displayName)) return "SYSTEM";
  return "HUMAN";
}

export function classifyMemberIdentity(input: MemberIdentityInput): MemberKind {
  if (input?.kind) return input.kind;
  const user = identityUser(input);
  if (inferMemberKindFromUserIdentity(user) === "SYSTEM") return "SYSTEM";
  return "HUMAN";
}

export function isSystemMemberIdentity(input: MemberIdentityInput) {
  return classifyMemberIdentity(input) === "SYSTEM";
}

export function isHumanMemberIdentity(input: MemberIdentityInput) {
  return classifyMemberIdentity(input) === "HUMAN";
}

export function systemMemberIdentityWhere(): Prisma.MemberWhereInput {
  return { kind: "SYSTEM" };
}

export function systemActorMemberIdentityWhere(): Prisma.MemberWhereInput {
  return { kind: "SYSTEM" };
}

export function humanMemberIdentityWhere(): Prisma.MemberWhereInput {
  return {
    kind: "HUMAN",
    NOT: [{ OR: [{ kind: "SYSTEM" }] }],
  };
}
