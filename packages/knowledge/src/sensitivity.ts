export type SensitivityLabel = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "PII";

export type SensitivityResult = {
  label: SensitivityLabel;
  matchedPatterns: string[];
};

type Pattern = {
  name: string;
  regex: RegExp;
  label: "CONFIDENTIAL" | "PII";
};

const BUILTIN_PATTERNS: Pattern[] = [
  { name: "email", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: "PII" },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g, label: "PII" },
  { name: "credit_card", regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g, label: "PII" },
  { name: "phone_us", regex: /\b(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, label: "PII" },
  { name: "ip_address", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, label: "CONFIDENTIAL" },
  { name: "salary_amount", regex: /\$\s*\d{2,3},?\d{3}(?:\.\d{2})?\s*(?:per\s+(?:year|annum|month)|\/?(?:yr|mo))/gi, label: "CONFIDENTIAL" },
  { name: "bank_account", regex: /\b\d{8,17}\b.*(?:routing|account|iban|swift)/gi, label: "PII" },
  { name: "passport", regex: /\b[A-Z]{1,2}\d{6,9}\b/g, label: "PII" },
];

export function classifyChunkSensitivity(content: string): SensitivityResult {
  const matchedPatterns: string[] = [];
  let highestSensitivity: SensitivityLabel = "PUBLIC";

  for (const pattern of BUILTIN_PATTERNS) {
    if (pattern.regex.test(content)) {
      matchedPatterns.push(pattern.name);
      
      if (pattern.label === "PII") {
        highestSensitivity = "PII";
      } else if (pattern.label === "CONFIDENTIAL" && highestSensitivity !== "PII") {
        highestSensitivity = "CONFIDENTIAL";
      }
    }
  }

  return {
    label: highestSensitivity,
    matchedPatterns,
  };
}
