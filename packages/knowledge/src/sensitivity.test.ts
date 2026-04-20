import { describe, expect, it } from "vitest";
import { classifyChunkSensitivity } from "./sensitivity";

describe("classifyChunkSensitivity", () => {
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
