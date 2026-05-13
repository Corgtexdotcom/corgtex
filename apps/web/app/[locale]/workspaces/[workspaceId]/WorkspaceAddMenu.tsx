"use client";

import type { MemberRole } from "@prisma/client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  getWorkspaceAddActions,
  type WorkspaceAddInvitePolicy,
} from "@/lib/workspace-add-actions";
import type { WorkspaceFeatureFlagMap } from "@/lib/workspace-feature-flags";

type WorkspaceAddMenuProps = {
  workspaceId: string;
  featureFlags: WorkspaceFeatureFlagMap;
  role: MemberRole | null;
  invitePolicy: WorkspaceAddInvitePolicy | null;
  meetingRecorderEnabled: boolean;
  isDemo: boolean;
};

export function WorkspaceAddMenu({
  workspaceId,
  featureFlags,
  role,
  invitePolicy,
  meetingRecorderEnabled,
  isDemo,
}: WorkspaceAddMenuProps) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const search = searchParams?.toString() ?? "";
  const actions = useMemo(() => (
    getWorkspaceAddActions({
      workspaceId,
      pathname,
      searchParams: search,
      featureFlags,
      role,
      invitePolicy,
      meetingRecorderEnabled,
      isDemo,
    })
  ), [workspaceId, pathname, search, featureFlags, role, invitePolicy, meetingRecorderEnabled, isDemo]);

  useEffect(() => {
    setIsOpen(false);
  }, [pathname, search]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  if (actions.length === 0) return null;

  const currentPath = `${pathname || `/workspaces/${workspaceId}`}${search ? `?${search}` : ""}`;
  const goToAction = (kind: string) => {
    const href = `/workspaces/${workspaceId}/add?kind=${encodeURIComponent(kind)}&returnTo=${encodeURIComponent(currentPath)}`;
    router.push(href);
  };

  if (actions.length === 1) {
    const [singleAction] = actions;
    return (
      <div className="workspace-add-menu" ref={rootRef}>
        <button
          type="button"
          className="workspace-add-button"
          aria-label={`Add ${singleAction.label}`}
          title={`Add ${singleAction.label}`}
          onClick={() => goToAction(singleAction.kind)}
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className="workspace-add-menu" ref={rootRef}>
      <button
        type="button"
        className="workspace-add-button"
        aria-label="Add"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        title="Add"
        onClick={() => setIsOpen((open) => !open)}
      >
        +
      </button>
      {isOpen && (
        <div className="workspace-add-dropdown" role="menu" aria-label="Add">
          <div className="workspace-add-dropdown-title">Add</div>
          {actions.map((item) => (
            <button
              key={item.kind}
              type="button"
              className="workspace-add-item"
              role="menuitem"
              onClick={() => goToAction(item.kind)}
            >
              <span className="workspace-add-item-label">{item.label}</span>
              <span className="workspace-add-item-description">{item.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
