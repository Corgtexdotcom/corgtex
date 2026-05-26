import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readMessages(locale: "en" | "es") {
  return JSON.parse(readFileSync(new URL(`./${locale}.json`, import.meta.url), "utf8")) as {
    proposals: {
      btnCreateDraft: string;
      newProposalTitle: string;
    };
  };
}

describe("proposal creation copy", () => {
  it("uses neutral create-proposal wording instead of draft wording", () => {
    const en = readMessages("en");
    const es = readMessages("es");

    expect(en.proposals.btnCreateDraft).toBe("Create proposal");
    expect(en.proposals.newProposalTitle).toBe("+ Create a proposal");
    expect(en.proposals.btnCreateDraft).not.toMatch(/draft/i);
    expect(en.proposals.newProposalTitle).not.toMatch(/draft/i);

    expect(es.proposals.btnCreateDraft).toBe("Crear propuesta");
    expect(es.proposals.newProposalTitle).toBe("+ Crear propuesta");
    expect(es.proposals.btnCreateDraft).not.toMatch(/borrador/i);
    expect(es.proposals.newProposalTitle).not.toMatch(/borrador/i);
  });
});
