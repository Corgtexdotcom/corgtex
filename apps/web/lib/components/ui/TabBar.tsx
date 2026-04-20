import Link from "next/link";

export type TabItem = {
  key: string;
  label: string;
};

interface TabBarProps {
  tabs: TabItem[];
  activeTab: string;
  baseHref?: string;
  onTabChange?: (key: string) => void;
  className?: string;
}

export function TabBar({ tabs, activeTab, baseHref, onTabChange, className = "" }: TabBarProps) {
  return (
    <div className={`nr-tab-bar ${className}`}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.key;
        
        if (baseHref) {
          const href = tab.key === tabs[0].key ? baseHref : `${baseHref}?tab=${tab.key}`;
          return (
            <Link
              key={tab.key}
              href={href}
              className={`nr-tab ${isActive ? "nr-tab-active" : ""}`}
            >
              {tab.label}
            </Link>
          );
        }

        return (
          <button
            key={tab.key}
            onClick={() => onTabChange && onTabChange(tab.key)}
            className={`nr-tab ${isActive ? "nr-tab-active" : ""}`}
            style={{ background: 'none', border: 'none', cursor: 'pointer', borderBottom: '2px solid transparent' }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
