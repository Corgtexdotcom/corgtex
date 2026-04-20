import { ReactNode } from "react";

export type StatItem = {
  key: string;
  label: string;
  value: string | number | ReactNode;
};

interface StatRowProps {
  stats: StatItem[];
  className?: string;
  prefix?: string; // e.g. "ws" or "nr" for the CSS classes
}

export function StatRow({ stats, className = "", prefix = "nr" }: StatRowProps) {
  if (stats.length === 0) return null;

  return (
    <div className={`${prefix}-stat-bar ${className}`}>
      {stats.map((stat, index) => (
        <span key={stat.key} style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
          <strong
            style={{
              fontFamily: "var(--font-playfair)",
              fontSize: "1.2rem",
              fontWeight: 700,
            }}
          >
            {stat.value}
          </strong>
          <span
            style={{
              fontSize: "0.85rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--muted)",
            }}
          >
            {stat.label}
          </span>
          {index < stats.length - 1 && (
            <span className={`${prefix}-stat-sep`} style={{ margin: "0 16px" }}>•</span>
          )}
        </span>
      ))}
    </div>
  );
}
