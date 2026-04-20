import Link from "next/link";

export type FilterItem = {
  key: string;
  label: string;
  count?: number;
};

interface FilterBarProps {
  items: FilterItem[];
  activeKey: string;
  baseHref?: string;
  onFilterChange?: (key: string) => void;
  className?: string;
  paramName?: string;
}

export function FilterBar({ items, activeKey, baseHref, onFilterChange, className = "", paramName = "status" }: FilterBarProps) {
  return (
    <div className={`nr-filter-bar ${className}`}>
      {items.map((item) => {
        const isActive = activeKey === item.key;
        const buttonContent = (
          <>
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span style={{ opacity: isActive ? 0.9 : 0.6, fontSize: "0.85em", marginLeft: 6 }}>
                ({item.count})
              </span>
            )}
          </>
        );

        const itemClassName = `nr-filter-item ${isActive ? "nr-filter-active" : ""}`;

        if (baseHref) {
          const href = item.key === items[0].key ? baseHref : `${baseHref}?${paramName}=${item.key}`;
          return (
            <Link
              key={item.key}
              href={href}
              className={itemClassName}
            >
              {buttonContent}
            </Link>
          );
        }

        return (
          <button
            key={item.key}
            onClick={() => onFilterChange && onFilterChange(item.key)}
            className={itemClassName}
            disabled={isActive}
            style={isActive ? {} : { background: 'transparent' }}
          >
            {buttonContent}
          </button>
        );
      })}
    </div>
  );
}
