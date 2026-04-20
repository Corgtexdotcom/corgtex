import { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`nr-item ${className}`} style={{ textAlign: "center", padding: "48px 24px" }}>
      {icon && (
        <div style={{ fontSize: "2rem", opacity: 0.5, marginBottom: "16px" }}>
          {icon}
        </div>
      )}
      <h3 style={{ fontSize: "1.1rem", marginBottom: "8px", fontFamily: "var(--font-playfair)" }}>
        {title}
      </h3>
      <p className="muted" style={{ maxWidth: "400px", margin: "0 auto 24px", lineHeight: 1.5 }}>
        {description}
      </p>
      {action && (
        <div>{action}</div>
      )}
    </div>
  );
}
