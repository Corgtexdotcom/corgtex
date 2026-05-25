"use client";

import { useEffect, useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { Search, LayoutDashboard, Bot, GitBranch, Activity, UserCheck, ShieldAlert, ArrowRight } from "lucide-react";
import { useRouter } from "@/i18n/routing";
import { cn } from "@/lib/utils";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const t = useTranslations("controlPlane");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = [
    {
      title: t("nav.dashboard"),
      description: t("commandPalette.items.dashboard"),
      href: "/control-plane",
      icon: LayoutDashboard,
    },
    {
      title: t("nav.customers"),
      description: t("commandPalette.items.customers"),
      href: "/control-plane#fleet",
      icon: ShieldAlert,
    },
    {
      title: t("nav.agents"),
      description: t("commandPalette.items.agents"),
      href: "/control-plane/agents",
      icon: Bot,
    },
    {
      title: t("nav.releases"),
      description: t("commandPalette.items.releases"),
      href: "/control-plane/releases",
      icon: GitBranch,
    },
    {
      title: t("nav.operations"),
      description: t("commandPalette.items.operations"),
      href: "/control-plane/operations",
      icon: Activity,
    },
    {
      title: t("nav.users"),
      description: t("commandPalette.items.users"),
      href: "/control-plane/users",
      icon: UserCheck,
    },
  ];

  const filteredItems = items.filter((item) =>
    item.title.toLowerCase().includes(query.toLowerCase()) ||
    item.description.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filteredItems.length > 0) {
          setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filteredItems.length > 0) {
          setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filteredItems[selectedIndex]) {
          router.push(filteredItems[selectedIndex].href);
          onClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, filteredItems, selectedIndex, router, onClose]);

  // Adjust scroll position when active index changes
  useEffect(() => {
    if (listRef.current) {
      const activeEl = listRef.current.children[selectedIndex] as HTMLElement;
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15dvh] px-4">
      {/* Backdrop scrim */}
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={onClose} />

      {/* Palette dialog container */}
      <div className="relative w-full max-w-xl bg-[#0e121a] border border-[#202738] rounded-xl shadow-2xl shadow-black/80 overflow-hidden flex flex-col max-h-[60dvh] transform transition-all animate-in fade-in zoom-in-95 duration-150">
        
        {/* Input area */}
        <div className="flex items-center gap-3 px-4 border-b border-[#202738] h-14 shrink-0 bg-[#0a0d14]">
          <Search className="w-5 h-5 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            className="w-full bg-transparent border-0 ring-0 outline-none text-slate-100 placeholder-slate-500 text-sm focus:outline-none"
            placeholder={t("commandPalette.placeholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
          <kbd className="hidden sm:inline-block bg-[#1f2638] text-[10px] text-slate-400 px-1.5 py-0.5 rounded border border-[#2e3752] uppercase shrink-0">
            esc
          </kbd>
        </div>

        {/* Action / Suggestions items list */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-2 space-y-0.5 scrollbar-thin">
          {filteredItems.map((item, idx) => {
            const Icon = item.icon;
            const isSelected = idx === selectedIndex;
            return (
              <button
                key={item.href}
                onClick={() => {
                  router.push(item.href);
                  onClose();
                }}
                className={cn(
                  "flex items-center gap-4 w-full text-left px-3 py-3 rounded-lg transition-all duration-100 border",
                  isSelected
                    ? "bg-[#1d2333] border-brand-500/20 text-white shadow-inner"
                    : "border-transparent text-slate-400 hover:bg-[#141822] hover:text-slate-200"
                )}
              >
                <div className={cn(
                  "flex items-center justify-center w-9 h-9 rounded-lg border",
                  isSelected 
                    ? "bg-brand-600/20 border-brand-500/30 text-brand-400"
                    : "bg-[#141822] border-[#202738] text-slate-400"
                )}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={cn("text-xs font-semibold tracking-wide", isSelected ? "text-white" : "text-slate-200")}>
                    {item.title}
                  </p>
                  <p className="text-[10px] text-slate-500 truncate mt-0.5">
                    {item.description}
                  </p>
                </div>
                {isSelected && <ArrowRight className="w-4 h-4 text-brand-400 shrink-0 animate-pulse" />}
              </button>
            );
          })}

          {filteredItems.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
              <p className="text-slate-400 font-medium text-xs">{t("commandPalette.emptyTitle")}</p>
              <p className="text-[10px] text-slate-600 mt-1">{t("commandPalette.emptyHint")}</p>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
