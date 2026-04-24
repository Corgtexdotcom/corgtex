import Link from "next/link";

export type PersonData = {
  memberId: string;
  userId: string;
  displayName: string;
  email: string;
  roleName?: string;
  workspaceId: string;
};

export default function PersonNode({ person }: { person: PersonData }) {
  const isAgent = person.email.includes("agent") || person.displayName.toLowerCase().includes("agent") || person.email.includes("system+");
  
  const initials = person.displayName
    ? person.displayName.split(" ").map(n => n[0]).join("").substring(0, 2).toUpperCase()
    : person.email.substring(0, 2).toUpperCase();

  return (
    <Link href={`/workspaces/${person.workspaceId}/members/${person.memberId}`} className={`person-chip ${isAgent ? "agent-chip" : ""}`}>
      <div className="person-avatar">
        {isAgent ? "⬡" : initials}
      </div>
      <div className="person-info">
        <span className="person-name">{person.displayName || person.email}</span>
        {person.roleName && <span className="person-role-name">{person.roleName}</span>}
      </div>
    </Link>
  );
}
