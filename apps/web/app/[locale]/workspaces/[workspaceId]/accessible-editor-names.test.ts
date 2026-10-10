import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import { DecisionFields } from "./decisions/DecisionFields";
import { ProposalDraftFields } from "./proposals/ProposalDraftFields";
import { ActionEditorForm } from "@/lib/components/ActionEditorForm";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";

const current = vi.hoisted(() => ({ locale: "en" as "en" | "es" }));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "decisions") => {
    const { createTranslator } = await import("next-intl");
    const messages = current.locale === "en"
      ? (await import("@/messages/en.json")).default
      : (await import("@/messages/es.json")).default;
    return createTranslator({ locale: current.locale, messages, namespace });
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/components/WorkItemMemberSelect", () => ({
  WorkItemMemberSelect: () => null,
}));

vi.mock("@/lib/components/WorkItemPrioritySelect", () => ({
  WorkItemPrioritySelect: () => null,
}));

function render(locale: "en" | "es", children: ReactNode) {
  current.locale = locale;
  // next-intl requires children in the provider props type for this server render fixture.
  // eslint-disable-next-line react/no-children-prop
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale, messages: locale === "en" ? en : es, timeZone: "UTC", children }));
}

function textareaTag(html: string) {
  const tag = html.match(/<textarea\b[^>]*name="bodyMd"[^>]*>/)?.[0];
  expect(tag).toBeDefined();
  return tag!;
}

function idFrom(tag: string) {
  const id = tag.match(/\bid="([^"]+)"/)?.[1];
  expect(id).toBeDefined();
  return id!;
}

function expectLabelBeforeToolbar(html: string, id: string, label: string) {
  const labelStart = html.indexOf(`<label for="${id}">${label}`);
  expect(labelStart).toBeGreaterThanOrEqual(0);
  const labelEnd = html.indexOf("</label>", labelStart);
  const editorStart = html.indexOf('class="md-editor"', labelStart);
  expect(labelEnd).toBeLessThan(editorStart);
}

describe("accessible Markdown editors", () => {
  it.each(["en", "es"] as const)("associates the visible Decision body label in %s", async (locale) => {
    current.locale = locale;
    const fields = await DecisionFields({ workspaceId: "synthetic-workspace", proposals: [], tensions: [] });
    const html = render(locale, fields);
    const textarea = textareaTag(html);
    const id = idFrom(textarea);
    const label = createTranslator({ locale, messages: locale === "en" ? en : es, namespace: "decisions" })("details");

    expect(textarea).toContain(" required");
    expectLabelBeforeToolbar(html, id, label);
    expect(html.indexOf("md-editor-tab")).toBeLessThan(html.indexOf(textarea));
  });

  it("generates distinct Decision textarea ids when fields render together", async () => {
    current.locale = "en";
    const first = await DecisionFields({ workspaceId: "synthetic-workspace", proposals: [], tensions: [] });
    const second = await DecisionFields({ workspaceId: "synthetic-workspace", proposals: [], tensions: [] });
    const html = render("en", createElement(Fragment, null, first, second));
    const ids = [...html.matchAll(/<textarea\b[^>]*name="bodyMd"[^>]*>/g)].map((match) => idFrom(match[0]));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it.each(["en", "es"] as const)("associates Proposal body with its localized label in %s", (locale) => {
    const html = render(locale, createElement(ProposalDraftFields, { members: [] }));
    const textarea = textareaTag(html);
    const id = idFrom(textarea);
    const label = createTranslator({ locale, messages: locale === "en" ? en : es, namespace: "proposals" })("formBody");
    expect(textarea).toContain(" required");
    expectLabelBeforeToolbar(html, id, label);
  });

  it("gives each Proposal editor its own id", () => {
    const html = render("en", createElement(Fragment, null,
      createElement(ProposalDraftFields, { members: [] }),
      createElement(ProposalDraftFields, { members: [] }),
    ));
    const ids = [...html.matchAll(/<textarea\b[^>]*name="bodyMd"[^>]*>/g)].map((match) => idFrom(match[0]));
    expect(new Set(ids).size).toBe(2);
  });

  it.each([{ locale: "en", notes: "Notes" }, { locale: "es", notes: "Notas" }] as const)(
    "associates Action $locale Notes without changing its form fields",
    ({ locale, notes }) => {
      const html = render(locale, createElement(ActionEditorForm, {
        action: async () => undefined,
        workspaceId: "synthetic-workspace",
        members: [],
        labels: {
          title: "Title", notes, assignee: "Assignee", assigneeNone: "None",
          submit: "Save", cancel: "Cancel", dueDate: "Due date", priorityLabel: "Priority",
          priority: { 3: "Urgent", 2: "Important", 1: "Medium", 0: "Low" },
        },
      }));
      const id = idFrom(textareaTag(html));
      expectLabelBeforeToolbar(html, id, notes);
      expect(html).toContain("name=\"workspaceId\"");
    },
  );

  it("gives separate Action forms distinct Notes ids", () => {
    const labels = {
      title: "Title", notes: "Notes", assignee: "Assignee", assigneeNone: "None",
      submit: "Save", cancel: "Cancel", dueDate: "Due date", priorityLabel: "Priority",
      priority: { 3: "Urgent", 2: "Important", 1: "Medium", 0: "Low" },
    };
    const html = render("en", createElement(Fragment, null,
      createElement(ActionEditorForm, { action: async () => undefined, workspaceId: "synthetic-workspace", members: [], labels }),
      createElement(ActionEditorForm, { action: async () => undefined, workspaceId: "synthetic-workspace", members: [], labels }),
    ));
    const ids = [...html.matchAll(/<textarea\b[^>]*name="bodyMd"[^>]*>/g)].map((match) => idFrom(match[0]));
    expect(new Set(ids).size).toBe(2);
  });

  it.each(["en", "es"] as const)("names the discussion textarea in %s without changing mention controls", (locale) => {
    const html = render(locale, createElement(DeliberationComposer, {
      hiddenFields: { workspaceId: "synthetic-workspace" },
      entryTypes: [{ value: "REACTION", label: "Reaction", variant: "neutral" }],
    }));
    const label = createTranslator({ locale, messages: locale === "en" ? en : es, namespace: "deliberation" })("entryPlaceholder");
    expect(textareaTag(html)).toContain(`aria-label="${label}"`);
    expect(html).toContain("name=\"workspaceId\"");
    expect(html).toContain("md-editor-tab");
  });

  it("passes explicit names and required validation to the real textarea", () => {
    const html = render("en", createElement(MarkdownEditor, {
      id: "synthetic-editor", name: "bodyMd", ariaLabel: "Reply text", required: true,
    }));
    const textarea = textareaTag(html);
    expect(textarea).toContain('id="synthetic-editor"');
    expect(textarea).toContain('aria-label="Reply text"');
    expect(textarea).toContain(" required");
  });
});
