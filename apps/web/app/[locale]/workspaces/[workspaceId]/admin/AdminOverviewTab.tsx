"use client";

import { useTranslations } from "next-intl";

interface Props {
  workspaceId: string;
  data: {
    workspacesCount: number;
    usersCount: number;
    activeMembersCount: number;
    worker: {
      isHealthy: boolean;
      lastJobAt: Date | null;
      pendingJobs: number;
      failedJobs: number;
    };
    externalInstances: any[];
  };
}

export function AdminOverviewTab({ data, workspaceId }: Props) {
  const t = useTranslations("admin");

  return (
    <div className="admin-overview stack" style={{ gap: 32 }}>
      <div 
        style={{ 
          display: "grid", 
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", 
          gap: 24 
        }}
      >
        <div className="card" style={{ padding: 24 }}>
          <h3 className="title-sm" style={{ color: "var(--gray-11)", marginBottom: 8 }}>{t("statTotalWorkspaces")}</h3>
          <div className="title-xl" style={{ fontSize: 32, fontWeight: 600 }}>{data.workspacesCount}</div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          <h3 className="title-sm" style={{ color: "var(--gray-11)", marginBottom: 8 }}>{t("statTotalUsers")}</h3>
          <div className="title-xl" style={{ fontSize: 32, fontWeight: 600 }}>{data.usersCount}</div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          <h3 className="title-sm" style={{ color: "var(--gray-11)", marginBottom: 8 }}>{t("statActiveMembers")}</h3>
          <div className="title-xl" style={{ fontSize: 32, fontWeight: 600 }}>{data.activeMembersCount}</div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          <h3 className="title-sm" style={{ color: "var(--gray-11)", marginBottom: 8 }}>{t("statWorkerStatus")}</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <div 
              style={{ 
                width: 12, 
                height: 12, 
                borderRadius: "50%", 
                backgroundColor: data.worker.isHealthy ? "var(--green-11)" : "var(--red-11)" 
              }} 
            />
            <div className="title-lg" style={{ fontWeight: 600 }}>
              {data.worker.isHealthy ? t("workerHealthy") : t("workerDown")}
            </div>
          </div>
          <div className="muted text-sm stack" style={{ gap: 4 }}>
            {data.worker.lastJobAt ? (
              <div>{t("lastJobAt", { date: new Date(data.worker.lastJobAt).toLocaleString() })}</div>
            ) : null}
            <div>{t("pendingJobs", { count: data.worker.pendingJobs })}</div>
            <div>{t("failedJobs", { count: data.worker.failedJobs })}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
