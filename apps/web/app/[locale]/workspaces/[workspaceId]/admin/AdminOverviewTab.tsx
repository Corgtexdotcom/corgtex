"use client";

import type { CSSProperties } from "react";
import { useTranslations } from "next-intl";

type NotificationDeliveryCounts = {
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
};

type NotificationDeliveryHealth = {
  windowDays: number;
  totals: NotificationDeliveryCounts;
  byChannel: Array<{ channel: string } & NotificationDeliveryCounts>;
  byType: Array<{ type: string; channel: string } & NotificationDeliveryCounts>;
};

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
    notificationDeliveryHealth?: NotificationDeliveryHealth;
    customerDeployments: any[];
  };
}

const deliveryStatuses: Array<{ key: keyof NotificationDeliveryCounts; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "sent", label: "Sent" },
  { key: "failed", label: "Failed" },
  { key: "skipped", label: "Skipped" },
];

const emptyDeliveryCounts: NotificationDeliveryCounts = {
  pending: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
};

const deliveryTableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "separate",
  borderSpacing: "0 6px",
  fontSize: "0.9rem",
};

const deliveryHeaderCellStyle: CSSProperties = {
  color: "var(--muted)",
  fontSize: "0.75rem",
  fontWeight: 700,
  padding: "0 12px 6px 0",
  textAlign: "left",
  whiteSpace: "nowrap",
};

const deliveryCellStyle: CSSProperties = {
  borderTop: "1px solid var(--line)",
  padding: "8px 12px 8px 0",
  verticalAlign: "top",
};

const deliveryMetricCellStyle: CSSProperties = {
  ...deliveryCellStyle,
  fontVariantNumeric: "tabular-nums",
  textAlign: "right",
  whiteSpace: "nowrap",
};

function emptyDeliveryHealth(): NotificationDeliveryHealth {
  return {
    windowDays: 30,
    totals: emptyDeliveryCounts,
    byChannel: [],
    byType: [],
  };
}

export function AdminOverviewTab({ data }: Props) {
  const t = useTranslations("admin");
  const notificationDeliveryHealth = data.notificationDeliveryHealth ?? emptyDeliveryHealth();
  const hasDeliveryRows = notificationDeliveryHealth.byChannel.length > 0 || notificationDeliveryHealth.byType.length > 0;

  return (
    <div className="admin-overview stack" style={{ gap: 32 }}>
      <div
        className="admin-stat-grid"
        style={{ 
          display: "grid", 
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", 
          gap: 24 
        }}
      >
        <div className="card admin-stat-card" style={{ padding: 24 }}>
          <h3 className="title-sm" style={{ color: "var(--gray-11)", marginBottom: 8 }}>{t("statTotalWorkspaces")}</h3>
          <div className="title-xl" style={{ fontSize: 32, fontWeight: 600 }}>{data.workspacesCount}</div>
        </div>

        <div className="card admin-stat-card" style={{ padding: 24 }}>
          <h3 className="title-sm" style={{ color: "var(--gray-11)", marginBottom: 8 }}>{t("statTotalUsers")}</h3>
          <div className="title-xl" style={{ fontSize: 32, fontWeight: 600 }}>{data.usersCount}</div>
        </div>

        <div className="card admin-stat-card" style={{ padding: 24 }}>
          <h3 className="title-sm" style={{ color: "var(--gray-11)", marginBottom: 8 }}>{t("statActiveMembers")}</h3>
          <div className="title-xl" style={{ fontSize: 32, fontWeight: 600 }}>{data.activeMembersCount}</div>
        </div>

        <div className="card admin-stat-card" style={{ padding: 24 }}>
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

      <section className="card stack" style={{ gap: 20, padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <h2 className="title-md" style={{ margin: 0 }}>Notification delivery health</h2>
            <p className="muted text-sm" style={{ margin: "4px 0 0" }}>
              Counts by channel and notification type. Message content and recipient details are excluded.
            </p>
          </div>
          <span className="status-chip status-chip-compact">Last {notificationDeliveryHealth.windowDays} days</span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          {deliveryStatuses.map((status) => (
            <div
              key={status.key}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 8,
                padding: "12px 14px",
                background: "var(--surface)",
              }}
            >
              <div className="muted text-sm" style={{ marginBottom: 4 }}>{status.label}</div>
              <div className="title-lg" style={{ fontWeight: 700 }}>{notificationDeliveryHealth.totals[status.key]}</div>
            </div>
          ))}
        </div>

        {hasDeliveryRows ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 24 }}>
            <div>
              <h3 className="title-sm" style={{ marginBottom: 10 }}>By channel</h3>
              <table style={deliveryTableStyle}>
                <thead>
                  <tr>
                    <th style={deliveryHeaderCellStyle}>Channel</th>
                    {deliveryStatuses.map((status) => (
                      <th key={status.key} style={{ ...deliveryHeaderCellStyle, textAlign: "right" }}>{status.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {notificationDeliveryHealth.byChannel.map((row) => (
                    <tr key={row.channel}>
                      <td style={deliveryCellStyle}>{row.channel}</td>
                      {deliveryStatuses.map((status) => (
                        <td key={status.key} style={deliveryMetricCellStyle}>{row[status.key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="title-sm" style={{ marginBottom: 10 }}>By notification type</h3>
              <table style={deliveryTableStyle}>
                <thead>
                  <tr>
                    <th style={deliveryHeaderCellStyle}>Type</th>
                    <th style={deliveryHeaderCellStyle}>Channel</th>
                    {deliveryStatuses.map((status) => (
                      <th key={status.key} style={{ ...deliveryHeaderCellStyle, textAlign: "right" }}>{status.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {notificationDeliveryHealth.byType.map((row) => (
                    <tr key={`${row.type}:${row.channel}`}>
                      <td style={{ ...deliveryCellStyle, maxWidth: 240, wordBreak: "break-word" }}>{row.type}</td>
                      <td style={deliveryCellStyle}>{row.channel}</td>
                      {deliveryStatuses.map((status) => (
                        <td key={status.key} style={deliveryMetricCellStyle}>{row[status.key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="muted text-sm" style={{ margin: 0 }}>No notification delivery attempts in this window.</p>
        )}
      </section>
    </div>
  );
}
