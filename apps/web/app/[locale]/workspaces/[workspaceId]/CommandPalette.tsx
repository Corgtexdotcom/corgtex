"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { WORKSPACE_NAV_GROUPS as navGroups } from "@/lib/nav-config";

// We'll move actionItems inside the component so we can use translations.

type Workspace = { id: string; name: string };

type CommandItem = {
  id: string;
  label: string;
  icon: string;
  desc?: string;
  group: string;
  onSelect: () => void;
};

export function CommandPalette({
  workspaceId,
  workspaces,
}: {
  workspaceId: string;
  workspaces: Workspace[];
}) {
  const router = useRouter();
  const tNav = useTranslations("nav");
  const tCmd = useTranslations("commandPalette");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  // Make an API available to open from elsewhere (like a sidebar button)
  useEffect(() => {
    const handleOpenToggle = () => setOpen(true);
    window.addEventListener("corgtex:open-command-palette", handleOpenToggle);
    return () => window.removeEventListener("corgtex:open-command-palette", handleOpenToggle);
  }, []);

  useEffect(() => {
    if (open) {
      setSearch("");
      setSelectedIndex(0);
    }
  }, [open]);

  if (!open) return null;

  const actionItems = [
    { href: "/tensions?open=new", label: tCmd("createTension"), icon: "+", desc: tCmd("createTensionDesc") },
    { href: "/proposals?open=new", label: tCmd("newProposal"), icon: "+", desc: tCmd("newProposalDesc") },
    { href: "/actions?open=new", label: tCmd("newAction"), icon: "+", desc: tCmd("newActionDesc") },
  ];

  // Build the unified list of commands
  const allCommands: CommandItem[] = [];

  // 1. Actions
  allCommands.push(
    ...actionItems.map((item) => ({
      id: `action-${item.label}`,
      label: item.label,
      icon: item.icon,
      desc: item.desc,
      group: tCmd("quickActions"),
      onSelect: () => {
        router.push(`/workspaces/${workspaceId}${item.href}`);
        setOpen(false);
      },
    }))
  );

  // 2. Navigation
  for (const group of navGroups) {
    allCommands.push(
      ...group.items.map((item) => ({
        id: `nav-${item.labelKey}`,
        label: tNav(item.labelKey as any),
        icon: item.icon,
        group: tCmd("navigation"),
        onSelect: () => {
          router.push(`/workspaces/${workspaceId}${item.href}`);
          setOpen(false);
        },
      }))
    );
  }

  // 3. Workspaces
  const otherWorkspaces = workspaces.filter((w) => w.id !== workspaceId);
  if (otherWorkspaces.length > 0) {
    allCommands.push(
      ...otherWorkspaces.map((w) => ({
        id: `ws-${w.id}`,
        label: w.name,
        icon: "◫",
        group: tCmd("switchWorkspace"),
        onSelect: () => {
          router.push(`/workspaces/${w.id}`);
          setOpen(false);
        },
      }))
    );
  }

  // Filter based on search input
  const query = search.toLowerCase().trim();
  const filteredCommands = query
    ? allCommands.filter((cmd) => cmd.label.toLowerCase().includes(query) || cmd.group.toLowerCase().includes(query))
    : allCommands;

  // Key event handling for navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % Math.max(filteredCommands.length, 1));
      scrollSelectedIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + filteredCommands.length) % Math.max(filteredCommands.length, 1));
      scrollSelectedIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        filteredCommands[selectedIndex].onSelect();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  const scrollSelectedIntoView = () => {
    // Simple rough scrolling so the selected element stays in view
    setTimeout(() => {
      if (!listRef.current) return;
      const activeEl = listRef.current.querySelector('[data-active="true"]') as HTMLElement;
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }, 0);
  };

  // Group the filtered commands for rendering
  const commandsByGroup = filteredCommands.reduce((acc, cmd) => {
    if (!acc[cmd.group]) acc[cmd.group] = [];
    acc[cmd.group].push(cmd);
    return acc;
  }, {} as Record<string, CommandItem[]>);

  let flatIndex = 0;

  return (
    <div className="cmd-backdrop" onClick={() => setOpen(false)}>
      <div
        className="cmd-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <input
          autoFocus
          className="cmd-input"
          placeholder={tCmd("placeholder")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="cmd-list" ref={listRef}>
          {filteredCommands.length === 0 ? (
            <div className="cmd-empty">{tCmd("noResults", { query: search })}</div>
          ) : (
            Object.entries(commandsByGroup).map(([group, cmds]) => (
              <div key={group} className="cmd-group">
                <div className="cmd-group-label">{group}</div>
                {cmds.map((cmd) => {
                  const isActive = flatIndex === selectedIndex;
                  const currentIndex = flatIndex++;
                  return (
                    <button
                      key={cmd.id}
                      className="cmd-item"
                      data-active={isActive}
                      onMouseEnter={() => setSelectedIndex(currentIndex)}
                      onClick={cmd.onSelect}
                    >
                      <span className="cmd-item-icon">{cmd.icon}</span>
                      <div className="cmd-item-content">
                        <span>{cmd.label}</span>
                        {cmd.desc && <span className="cmd-item-desc">{cmd.desc}</span>}
                      </div>
                      {group === tCmd("quickActions") && !isActive && <span className="cmd-kbd">↵</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
