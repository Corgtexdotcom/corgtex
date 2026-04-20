import { ReactNode } from "react";

interface CollapsibleFormProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  onOpenChange?: (isOpen: boolean) => void;
}

export function CollapsibleForm({ 
  title, 
  defaultOpen = false, 
  children, 
  className = "",
  onOpenChange
}: CollapsibleFormProps) {
  return (
    <details 
      className={`panel ${className}`} 
      style={{ marginBottom: 32 }}
      open={defaultOpen}
      onToggle={(e) => onOpenChange && onOpenChange(e.currentTarget.open)}
    >
      <summary 
        className="nr-hide-marker"
        style={{ cursor: "pointer", fontWeight: 600, paddingBottom: 8, listStyle: "none" }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transition: "transform 0.2s" }} className="collapsible-icon">
              <path d="M1 3L5 7L9 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          {title}
        </span>
      </summary>
      <style dangerouslySetInnerHTML={{__html: `
        details[open] .collapsible-icon { transform: rotate(180deg); }
      `}} />
      <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
        {children}
      </div>
    </details>
  );
}
