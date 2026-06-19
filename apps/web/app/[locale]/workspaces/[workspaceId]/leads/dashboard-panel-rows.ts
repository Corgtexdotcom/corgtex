export const CRM_DASHBOARD_PANEL_ROW_LIMIT = 5;

export function capDashboardPanelRows<T>(
  rows: T[],
  limit = CRM_DASHBOARD_PANEL_ROW_LIMIT,
) {
  return rows.slice(0, limit);
}
