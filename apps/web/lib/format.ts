export function ageText(date: Date): string {
  const ms = Date.now() - date.getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatDateTime(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function statusColor(status: string): string {
  if (status === "DRAFT") return "var(--muted)";
  if (status === "ACTIVE") return "var(--text)";
  if (status === "PUBLISHED") return "var(--text)";
  if (status === "SUBMITTED" || status === "PENDING") return "var(--warning)";
  if (status === "APPROVED" || status === "PAID" || status === "SUCCESS") return "var(--success)";
  if (status === "REJECTED" || status === "FAILED") return "var(--error)";
  if (status === "RESOLVED") return "var(--success)";
  return "var(--text)";
}
