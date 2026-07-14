import type { CSSProperties } from "react";

export type WorkItemMemberOption = {
  id: string;
  label: string;
};

export function WorkItemMemberSelect({
  label,
  members,
  noneLabel,
  defaultValue = "",
  name,
  className,
  style,
}: {
  label: string;
  members: WorkItemMemberOption[];
  noneLabel: string;
  defaultValue?: string | null;
  name: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <label className={className} style={style}>
      {label}
      <select name={name} defaultValue={defaultValue ?? ""}>
        <option value="">{noneLabel}</option>
        {members.map((member) => (
          <option value={member.id} key={member.id}>{member.label}</option>
        ))}
      </select>
    </label>
  );
}
