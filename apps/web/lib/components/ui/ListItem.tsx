import { ReactNode } from "react";

interface ListItemProps {
  title: string | ReactNode;
  meta: ReactNode;
  excerpt?: string | ReactNode;
  statusBadge?: ReactNode;
  actions?: ReactNode;
  className?: string;
  onClick?: () => void;
}

export function ListItem({ title, meta, excerpt, statusBadge, actions, className = "", onClick }: ListItemProps) {
  const isClickable = !!onClick;
  
  return (
    <div 
      className={`nr-item ${className}`}
      onClick={onClick}
      style={{ cursor: isClickable ? 'pointer' : 'default' , ...isClickable ? { transition: 'background 0.2s', padding: '12px', margin: '0 -12px', borderRadius: '8px' }: {} }}
      onMouseEnter={e => { if (isClickable) e.currentTarget.style.background = 'var(--accent-soft)'; }}
      onMouseLeave={e => { if (isClickable) e.currentTarget.style.background = 'transparent'; }}
    >
      <div className="row" style={{ alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <h3 className="nr-item-title" style={{ margin: 0, padding: 0 }}>
              {title}
            </h3>
            {statusBadge}
          </div>
          <div className="nr-item-meta">{meta}</div>
        </div>
        
        {actions && (
          <div className="actions-inline" style={{ marginTop: 0 }} onClick={e => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>

      {excerpt && (
        <div className="nr-excerpt" style={{ marginTop: 8, fontSize: "0.85rem", color: "var(--muted)" }}>
          {excerpt}
        </div>
      )}
    </div>
  );
}
