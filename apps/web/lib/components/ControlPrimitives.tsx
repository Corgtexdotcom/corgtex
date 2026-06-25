import React, { type FormHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

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
