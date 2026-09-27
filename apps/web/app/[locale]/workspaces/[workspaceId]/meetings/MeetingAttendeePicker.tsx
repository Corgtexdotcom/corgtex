"use client";

import { useMemo, useState } from "react";

type Attendee = { id: string; name: string; email: string };

export function MeetingAttendeePicker({
  members,
  labels,
}: {
  members: Attendee[];
  labels: {
    members: string;
    searchMembers: string;
    externalEmails: string;
    externalEmailsPlaceholder: string;
    externalEmailsHelp: string;
  };
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [externalEmails, setExternalEmails] = useState("");
  const selected = useMemo(
    () => new Set(selectedIds.filter((id) => members.some((member) => member.id === id))),
    [members, selectedIds],
  );
  const visibleMembers = members.filter((member) =>
    `${member.name} ${member.email}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const selectedEmails = members
    .filter((member) => selected.has(member.id))
    .map((member) => member.email);
  const allEmails = [...selectedEmails, ...externalEmails.split(/[\n,;]+/)]
    .map((email) => email.trim())
    .filter(Boolean)
    .filter((email, index, values) => values.findIndex((value) => value.toLowerCase() === email.toLowerCase()) === index);

  return (
    <fieldset style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
      <legend style={{ fontWeight: 600, marginBottom: 8 }}>{labels.members}</legend>
      <input
        aria-label={labels.searchMembers}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={labels.searchMembers}
        type="search"
        style={{ width: "100%", marginBottom: 8 }}
      />
      <div style={{ display: "grid", gap: 4, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", maxHeight: 220, overflowY: "auto", padding: "4px 0" }}>
        {visibleMembers.map((member) => (
          <label key={member.id} style={{ alignItems: "flex-start", display: "flex", gap: 8, minWidth: 0 }}>
            <input
              checked={selected.has(member.id)}
              onChange={(event) => setSelectedIds((current) => event.target.checked
                ? [...new Set([...current, member.id])]
                : current.filter((id) => id !== member.id))}
              type="checkbox"
              value={member.id}
              style={{ flex: "0 0 auto", marginTop: 3, width: "auto" }}
            />
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              <span style={{ display: "block" }}>{member.name}</span>
              <span className="nr-meta">{member.email}</span>
            </span>
          </label>
        ))}
        {visibleMembers.length === 0 && <p className="nr-meta">—</p>}
      </div>
      <input type="hidden" name="participantIds" value={[...selected].join(",")} />
      <input type="hidden" name="participantEmails" value={allEmails.join(",")} />
      <label style={{ display: "block", marginTop: 12 }}>
        {labels.externalEmails}
        <textarea
          onChange={(event) => setExternalEmails(event.target.value)}
          placeholder={labels.externalEmailsPlaceholder}
          rows={2}
          value={externalEmails}
        />
      </label>
      <p className="nr-meta" style={{ marginTop: 4 }}>{labels.externalEmailsHelp}</p>
    </fieldset>
  );
}
