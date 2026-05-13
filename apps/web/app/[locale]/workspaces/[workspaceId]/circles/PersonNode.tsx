import Link from "next/link";
import type { CSSProperties } from "react";
import { getInitials } from "./circleGraphHelpers";

export type PersonData = {
  memberId: string;
  userId?: string;
  displayName: string;
  email: string;
  roleName?: string;
  avatarUrl?: string | null;
  bio?: string | null;
  workspaceId: string;
};

export default function PersonNode({
  person,
  compact = false,
  className = "",
  style,
}: {
  person: PersonData;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const isAgent = person.email.includes("agent") || person.displayName.toLowerCase().includes("agent") || person.email.includes("system+");
  const initials = getInitials(person.displayName, person.email);
  const title = [person.displayName || person.email, person.roleName, person.bio].filter(Boolean).join(" - ");

  return (
    <Link
      href={`/workspaces/${person.workspaceId}/members/${person.memberId}`}
      className={`person-chip nodrag nopan ${compact ? "person-chip-compact" : ""} ${isAgent ? "agent-chip" : ""} ${className}`}
      style={style}
      title={title}
      aria-label={title}
    >
      <span
        className={`person-avatar ${person.avatarUrl ? "person-avatar-image" : ""}`}
        style={person.avatarUrl ? { backgroundImage: `url(${JSON.stringify(person.avatarUrl)})` } : undefined}
        aria-hidden="true"
      >
        {!person.avatarUrl && (isAgent ? "⬡" : initials)}
      </span>
      {!compact && (
        <span className="person-info">
          <span className="person-name">{person.displayName || person.email}</span>
          {person.roleName && <span className="person-role-name">{person.roleName}</span>}
        </span>
      )}
    </Link>
  );
}
