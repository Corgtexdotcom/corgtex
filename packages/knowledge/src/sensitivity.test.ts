import { describe, expect, it } from "vitest";
import { classifyChunkSensitivity } from "./sensitivity";
import type { SensitivityResult } from "./sensitivity";

const detectorCases = [
  { name: "email", content: "Contact alice@example.com", label: "PII" },
  { name: "ssn", content: "SSN: 123-45-6789", label: "PII" },
  { name: "credit_card", content: "Card: 4111111111111111", label: "PII" },
  { name: "phone_us", content: "Call 555-123-4567", label: "PII" },
  { name: "ip_address", content: "Server: 192.168.1.100", label: "CONFIDENTIAL" },
  { name: "salary_amount", content: "Salary: $125,000/YR", label: "CONFIDENTIAL" },
  { name: "bank_account", content: "12345678 ACCOUNT", label: "PII" },
  { name: "passport", content: "Passport: AB1234567", label: "PII" },
] as const;

const classificationCases: Array<{ content: string; expected: SensitivityResult }> = [
  ...detectorCases.map(({ name, content, label }) => ({
    content,
    expected: { label, matchedPatterns: [name] },
  })),
  { content: "Board meeting agenda", expected: { label: "PUBLIC", matchedPatterns: [] } },
  { content: "", expected: { label: "PUBLIC", matchedPatterns: [] } },
  {
    content: "Server 192.168.1.10 is maintained by admin@example.com.",
    expected: { label: "PII", matchedPatterns: ["email", "ip_address"] },
  },
];

describe("classifyChunkSensitivity", () => {
  it.each(detectorCases)("should consistently detect $name on repeated input", ({ name, content, label }) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(classifyChunkSensitivity(content)).toEqual({ label, matchedPatterns: [name] });
    }
  });

  it("should classify independently of prior inputs and their order", () => {
    const orders = [
      classificationCases,
      [...classificationCases].reverse(),
      [...classificationCases.slice(3), ...classificationCases.slice(0, 3)],
    ];
    for (const order of orders) {
      for (const { content: priorContent } of order) {
        for (const { content, expected } of classificationCases) {
          // A prior match late in a longer chunk must not hide an earlier match.
          classifyChunkSensitivity(`Background context. ${priorContent}`);
          expect(classifyChunkSensitivity(content)).toEqual(expected);
        }
      }
    }
  });

  it("should classify repeated chunks consistently across consecutive batches", () => {
    const batch = classificationCases.flatMap((sample) => [sample, sample, sample, sample]);
    const expected = batch.map((sample) => sample.expected);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(batch.map((sample) => classifyChunkSensitivity(sample.content))).toEqual(expected);
    }
  });

  it("should preserve detector boundaries, casing, and one match entry per detector", () => {
    expect(classifyChunkSensitivity("alice@example.com and bob@example.org")).toEqual({
      label: "PII",
      matchedPatterns: ["email"],
    });
    expect(classifyChunkSensitivity("Passport: ab1234567")).toEqual({ label: "PUBLIC", matchedPatterns: [] });
    expect(classifyChunkSensitivity("ID: XAB1234567X")).toEqual({ label: "PUBLIC", matchedPatterns: [] });
    expect(classifyChunkSensitivity("Server: 999.999.999.999")).toEqual({
      label: "CONFIDENTIAL",
      matchedPatterns: ["ip_address"],
    });
  });

  it("should classify emails as PII", () => {
    const result = classifyChunkSensitivity("Contact john.doe@acme.com for details");
    expect(result.label).toBe("PII");
    expect(result.matchedPatterns).toContain("email");
  });

  it("should classify SSNs as PII", () => {
    const result = classifyChunkSensitivity("My SSN is 123-45-6789.");
    expect(result.label).toBe("PII");
    expect(result.matchedPatterns).toContain("ssn");
  });

  it("should classify credit cards as PII", () => {
    const result = classifyChunkSensitivity("Card ending 4111111111111111");
    expect(result.label).toBe("PII");
    expect(result.matchedPatterns).toContain("credit_card");
  });

  it("should classify US phone numbers as PII", () => {
    const result = classifyChunkSensitivity("Call (555) 123-4567 regarding the incident.");
    expect(result.label).toBe("PII");
    expect(result.matchedPatterns).toContain("phone_us");
  });

  it("should classify IP addresses as CONFIDENTIAL", () => {
    const result = classifyChunkSensitivity("The server is at 192.168.1.100");
    expect(result.label).toBe("CONFIDENTIAL");
    expect(result.matchedPatterns).toContain("ip_address");
  });

  it("should classify salary amounts as CONFIDENTIAL", () => {
    const result = classifyChunkSensitivity("The offer was for Salary: $125,000/yr with bonus.");
    expect(result.label).toBe("CONFIDENTIAL");
    expect(result.matchedPatterns).toContain("salary_amount");
  });

  it("should classify plain business text as PUBLIC", () => {
    const result = classifyChunkSensitivity("Q3 revenue grew 15% YoY according to our latest reports.");
    expect(result.label).toBe("PUBLIC");
    expect(result.matchedPatterns).toHaveLength(0);
  });

  it("should classify plain text without sensitive info as PUBLIC", () => {
    const result = classifyChunkSensitivity("Board meeting agenda for Tuesday");
    expect(result.label).toBe("PUBLIC");
    expect(result.matchedPatterns).toHaveLength(0);
  });

  it("should return PII when both PII and CONFIDENTIAL are present", () => {
    const result = classifyChunkSensitivity("Server 192.168.1.10 is maintained by admin@example.com.");
    expect(result.label).toBe("PII");
    expect(result.matchedPatterns).toContain("ip_address");
    expect(result.matchedPatterns).toContain("email");
  });
});
