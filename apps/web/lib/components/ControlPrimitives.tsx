import React, {
  type AnchorHTMLAttributes,
  type FormHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

export function WorkspacePageHeader({
  title,
  description,
  eyebrow,
  actions,
  meta,
  subnav,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  subnav?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("nr-masthead nr-masthead-left nr-workspace-page-header", className)}>
      <div className="nr-workspace-page-header-main">
        <div className="nr-workspace-page-header-copy">
          {eyebrow && <div className="nr-page-eyebrow">{eyebrow}</div>}
          <h1 className="nr-masthead-title">{title}</h1>
          {description && (
            <div className="nr-masthead-meta">
              <span>{description}</span>
            </div>
          )}
          {meta && <div className="nr-page-meta">{meta}</div>}
        </div>
        {actions && <div className="nr-workspace-page-header-actions">{actions}</div>}
      </div>
      {subnav && <div className="nr-workspace-page-header-subnav">{subnav}</div>}
    </header>
  );
}

export type WorkspaceSubnavItem = {
  key: string;
  label: ReactNode;
  href: string;
  active?: boolean;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href">;

export function WorkspaceSubnav({
  label,
  items,
  className,
}: {
  label: string;
  items: WorkspaceSubnavItem[];
  className?: string;
}) {
  return (
    <nav className={cn("nr-workspace-subnav", className)} aria-label={label}>
      {items.map(({ key, label: itemLabel, href, active, className: itemClassName, ...itemProps }) => (
        <a
          key={key}
          href={href}
          className={cn("nr-workspace-subnav-link", active && "nr-workspace-subnav-link-active", itemClassName)}
          {...itemProps}
          aria-current={active ? "page" : itemProps["aria-current"]}
        >
          {itemLabel}
        </a>
      ))}
    </nav>
  );
}

export type SegmentedControlItem = {
  key: string;
  label: ReactNode;
  href: string;
  active?: boolean;
  icon?: ReactNode;
  ariaLabel?: string;
  title?: string;
};

export function SegmentedControl({
  label,
  items,
  className,
  density = "default",
  showLabels = "always",
}: {
  label: string;
  items: SegmentedControlItem[];
  className?: string;
  density?: "default" | "compact" | "icon";
  showLabels?: "always" | "sr-only";
}) {
  return (
    <nav
      className={cn(
        "nr-segmented-control",
        density === "compact" && "nr-segmented-control-compact",
        density === "icon" && "nr-segmented-control-icon",
        className,
      )}
      aria-label={label}
    >
      {items.map((item) => (
        <a
          key={item.key}
          href={item.href}
          className={cn("nr-segmented-item", item.active && "nr-segmented-item-active")}
          aria-current={item.active ? "page" : undefined}
          aria-label={item.ariaLabel}
          title={item.title}
        >
          {item.icon}
          <span className={showLabels === "sr-only" ? "sr-only" : undefined}>{item.label}</span>
        </a>
      ))}
    </nav>
  );
}

export function WorkspaceEmptyState({
  title,
  description,
  action,
  media,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  media?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("nr-empty-state", className)}>
      {media && <div className="nr-empty-media">{media}</div>}
      <h3 className="nr-empty-title">{title}</h3>
      {description && <p className="nr-empty-desc muted">{description}</p>}
      {action && <div className="nr-empty-action">{action}</div>}
    </div>
  );
}

type FilterToolbarDivProps = {
  as?: "div";
  children?: ReactNode;
  className?: string;
} & HTMLAttributes<HTMLDivElement>;

type FilterToolbarFormProps = {
  as: "form";
  children?: ReactNode;
  className?: string;
} & FormHTMLAttributes<HTMLFormElement>;

export function FilterToolbar(props: FilterToolbarDivProps | FilterToolbarFormProps) {
  if (props.as === "form") {
    const { as, children, className, ...formProps } = props;
    return (
      <form className={cn("nr-filter-panel", className)} {...formProps}>
        {children}
      </form>
    );
  }

  const { as, children, className, ...divProps } = props;
  return (
    <div className={cn("nr-filter-panel", className)} {...divProps}>
      {children}
    </div>
  );
}

export function FilterField({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("nr-filter-field", className)}>
      <span className="nr-item-meta">{label}</span>
      {children}
    </label>
  );
}

export function CheckboxFilter({
  children,
  className,
  ...inputProps
}: {
  children?: ReactNode;
  className?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cn("nr-checkbox-filter", className)}>
      <input type="checkbox" {...inputProps} />
      <span>{children}</span>
    </label>
  );
}

export function TableActionGroup({
  children,
  direction = "row",
  className,
}: {
  children?: ReactNode;
  direction?: "row" | "stack";
  className?: string;
}) {
  return (
    <div className={cn("nr-table-action-group", direction === "stack" && "nr-table-action-group-stack", className)}>
      {children}
    </div>
  );
}
