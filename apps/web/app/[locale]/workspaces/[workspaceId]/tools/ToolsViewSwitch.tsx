"use client";

import React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { normalizeCatalogQuery, normalizeCatalogType, normalizeToolsSurface, toolsFilterHref } from "./catalog-ui";

export function ToolsViewSwitch({ listLabel, gridLabel }: { listLabel: string; gridLabel: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedView = searchParams.get("view") === "grid" ? "grid" : "list";
  const type = normalizeCatalogType(searchParams.getAll("type"));
  const surface = normalizeToolsSurface(searchParams.getAll("surface"), searchParams.getAll("type"));
  const query = normalizeCatalogQuery(searchParams.getAll("q"));

  function viewHref(view: "list" | "grid") {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", view);
    return toolsFilterHref(pathname, params.toString(), { surface, type, query });
  }

  return (
    <div className="actions-inline">
      <a href={viewHref("list")} className="link-button small" style={{ opacity: selectedView === "list" ? 1 : 0.62 }}>
        {listLabel}
      </a>
      <a href={viewHref("grid")} className="link-button small" style={{ opacity: selectedView === "grid" ? 1 : 0.62 }}>
        {gridLabel}
      </a>
    </div>
  );
}
