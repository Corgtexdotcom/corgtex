import type { BrainArticleType } from "@prisma/client";
import React from "react";
import type { CSSProperties } from "react";

const EDITABLE_TYPES = [
  "PRODUCT", "ARCHITECTURE", "PROCESS", "RUNBOOK", "DECISION", "TEAM", "PERSON",
  "CUSTOMER", "INCIDENT", "PROJECT", "INTEGRATION", "PATTERN", "STRATEGY",
  "CULTURE", "GLOSSARY",
] as const satisfies readonly BrainArticleType[];

export function BrainArticleTypeControl({ type, label, style }: {
  type: BrainArticleType;
  label: string;
  style?: CSSProperties;
}) {
  if (type === "DIGEST") {
    return <input aria-label={label} value={type} readOnly style={style} />;
  }

  return (
    <select name="type" aria-label={label} defaultValue={type} style={style}>
      {EDITABLE_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}
