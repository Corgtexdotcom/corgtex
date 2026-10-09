import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import { WorkItemToolbar } from "@/lib/components/WorkItemControls";
import { ActionPagination } from "./ActionPagination";
import { buildActionListQuery } from "./view-model";

describe("Actions sort menu", () => {
  it.each([
    ["en", enMessages, "Due date · soonest first", "Created date · newest first"],
    ["es", esMessages, "Fecha de vencimiento · más próxima", "Fecha de creación · más reciente"],
  ] as const)("renders %s sort choices with an accessible active state", (locale, messages, dueLabel, createdLabel) => {
    const t = createTranslator({ locale, messages, namespace: "actions" });
    const work = createTranslator({ locale, messages, namespace: "workItems" });
    const html = renderToStaticMarkup(React.createElement(WorkItemToolbar, {
      currentView: "table",
      currentSort: "due_asc",
      listHref: "?view=list",
      kanbanHref: "?view=kanban",
      tableHref: "?view=table",
      sortLinks: { priority: "?", date: "?sort=date", alpha: "?sort=alpha" },
      customSortOptions: [
        { id: "priority", label: work("sortPriority"), href: "?" },
        { id: "date", label: t("sortCreatedNewest"), href: "?sort=date" },
        { id: "created_asc", label: t("sortCreatedOldest"), href: "?sort=created_asc" },
        { id: "due_asc", label: t("sortDueSoonest"), href: "?sort=due_asc" },
        { id: "due_desc", label: t("sortDueLatest"), href: "?sort=due_desc" },
        { id: "alpha", label: work("sortAlpha"), href: "?sort=alpha" },
      ],
      listLabel: work("listView"),
      kanbanLabel: work("kanbanView"),
      tableLabel: work("tableView"),
      sortLabel: work("sort"),
      sortPriorityLabel: work("sortPriority"),
      sortDateLabel: work("sortDate"),
      sortAlphaLabel: work("sortAlpha"),
      label: work("viewMode"),
    }));

    expect(html).toContain(createdLabel);
    expect(html).toContain(dueLabel);
    expect(html).toContain('href="?sort=due_asc" class="nr-icon-menu-item nr-icon-menu-item-active" aria-current="true"');
    expect(html).toContain(`aria-label="${work("sort")}"`);
    expect(html).toContain('href="?sort=due_desc"');
  });

  it.each([
    ["en", enMessages, "Action pages", "Next"],
    ["es", esMessages, "Páginas de acciones", "Siguiente"],
  ] as const)("renders %s pagination with selected filters in the next link", (locale, messages, label, nextText) => {
    const t = createTranslator({ locale, messages, namespace: "actions" });
    const nextHref = buildActionListQuery({ view: "table", status: ["OPEN"], sort: "due_asc", page: 2 }, "assigned");
    const html = renderToStaticMarkup(React.createElement(ActionPagination, {
      page: 1,
      pageCount: 2,
      summary: t("paginationSummary", { page: 1, pageCount: 2, count: 200, total: 205 }),
      previousHref: "?",
      nextHref,
      labels: { pagination: t("paginationLabel"), previous: t("paginationPrevious"), next: t("paginationNext") },
    }));

    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`${nextText}</a>`);
    expect(html).toContain("sort=due_asc&amp;page=2&amp;scope=assigned");
    expect(html).toContain("200");
    expect(renderToStaticMarkup(React.createElement(ActionPagination, {
      page: 1, pageCount: 1, summary: "", previousHref: "?", nextHref: "?",
      labels: { pagination: label, previous: "", next: nextText },
    }))).toBe("");
  });
});
