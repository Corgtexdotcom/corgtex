"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AdminOverviewTab } from "./AdminOverviewTab";
import { AdminWorkspacesTab } from "./AdminWorkspacesTab";
import { AdminUsersTab } from "./AdminUsersTab";
import { AdminOperationsTab } from "./AdminOperationsTab";

export function AdminDashboardClient({
  workspaceId,
  workspaces,
  users,
  overview,
  operations
}: {
  workspaceId: string;
  workspaces: any[];
  users: any[];
  overview: any;
  operations: any;
}) {
  const t = useTranslations("admin");
  const [tab, setTab] = useState<"overview" | "workspaces" | "users" | "operations">("overview");

  return (
    <div className="stack">
      <div className="nr-tabs" style={{ marginBottom: 24, gap: 8 }}>
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>{t("tabOverview")}</button>
        <button className={tab === "workspaces" ? "active" : ""} onClick={() => setTab("workspaces")}>{t("workspacesTab")}</button>
        <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>{t("usersTab")}</button>
        <button className={tab === "operations" ? "active" : ""} onClick={() => setTab("operations")}>{t("tabOperations")}</button>
      </div>

      {tab === "overview" && <AdminOverviewTab data={overview} workspaceId={workspaceId} />}
      {tab === "workspaces" && <AdminWorkspacesTab workspaces={workspaces} workspaceId={workspaceId} />}
      {tab === "users" && <AdminUsersTab users={users} workspaceId={workspaceId} />}
      {tab === "operations" && <AdminOperationsTab data={operations} workspaceId={workspaceId} />}
    </div>
  );
}

