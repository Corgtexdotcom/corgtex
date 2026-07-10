"use client";

import { Handle, Position } from "@xyflow/react";
import { Maximize2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { KeyboardEvent } from "react";
import PersonNode from "./PersonNode";
import type { CircleMemberPreview } from "./circleGraphHelpers";

export type CircleNodeData = {
  circleId: string;
  name: string;
  purposeMd: string | null;
  domainMd?: string | null;
  maturityStage: string;
  roleCount: number;
  memberCount: number;
  childCircleCount: number;
  accountabilityCount: number;
  members: CircleMemberPreview[];
  onExpand?: (circleId: string) => void;
  onToggle?: (circleId: string) => void;
  nodeWidth?: number;
  nodeHeight?: number;
};

const avatarPositions = [
  { left: "50%", top: "2%", transform: "translate(-50%, -50%)" },
  { left: "88%", top: "26%", transform: "translate(-50%, -50%)" },
  { left: "84%", top: "74%", transform: "translate(-50%, -50%)" },
  { left: "50%", top: "98%", transform: "translate(-50%, -50%)" },
  { left: "16%", top: "74%", transform: "translate(-50%, -50%)" },
  { left: "12%", top: "26%", transform: "translate(-50%, -50%)" },
];

export default function CircleNode({ data, selected }: { data: CircleNodeData; selected?: boolean }) {
  const t = useTranslations("circles");

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    data.onToggle?.(data.circleId);
  };

  const getBadgeClass = (stage: string) => {
    switch (stage) {
      case "BUILDING_MUSCLE": return "badge-building-muscle";
      case "FULL_O2": return "badge-full-o2";
      default: return "badge-getting-started";
    }
  };

  const getStageLabel = (stage: string) => {
    switch (stage) {
      case "BUILDING_MUSCLE": return t("stageBuildingMuscle");
      case "FULL_O2": return t("stageFullO2");
      default: return t("stageGettingStarted");
    }
  };

  return (
    <div
      className={`circle-node ${selected ? "selected" : ""}`}
      style={{ width: data.nodeWidth, height: data.nodeHeight }}
      role="button"
      tabIndex={0}
      aria-expanded={false}
      aria-label={`${data.name} ${t("expand")}`}
      onKeyDown={handleKeyDown}
    >
      <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
      <div className="circle-node-topline">
        <div className="circle-node-title">{data.name}</div>
        {data.onExpand && (
          <button 
            type="button" 
            className="circle-icon-button nodrag nopan"
            onClick={(e) => { e.stopPropagation(); data.onExpand!(data.circleId); }}
            aria-label={t("expand")}
            title={t("expand")}
          >
            <Maximize2 size={14} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="circle-node-visual">
        <div className="circle-node-orbit">
          <div className="circle-node-core">
            <span>{data.roleCount}</span>
            <small>{t("rolesShort")}</small>
          </div>
          {data.members.slice(0, 6).map((member, index) => (
            <PersonNode
              key={member.memberId}
              compact
              person={{
                memberId: member.memberId,
                userId: member.userId,
                kind: member.kind,
                displayName: member.displayName,
                email: member.email,
                avatarUrl: member.avatarUrl,
                bio: member.bio,
                roleName: member.roleNames.join(", "),
                workspaceId: member.workspaceId,
              }}
              className="circle-orbit-person"
              style={avatarPositions[index]}
            />
          ))}
        </div>
      </div>

      {data.purposeMd && <div className="circle-node-purpose">{data.purposeMd}</div>}

      <div className="circle-node-metrics">
        <span>
          <strong>{data.memberCount}</strong>
          {t("membersShort")}
        </span>
        <span>
          <strong>{data.accountabilityCount}</strong>
          {t("accountabilitiesShort")}
        </span>
        <span>
          <strong>{data.childCircleCount}</strong>
          {t("subcirclesShort")}
        </span>
      </div>

      <div className="circle-node-footer">
        <span className={`circle-node-badge ${getBadgeClass(data.maturityStage)}`}>
          {getStageLabel(data.maturityStage)}
        </span>
        <span className="circle-node-roles">{t("roleCount", { count: data.roleCount })}</span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: "hidden" }} />
    </div>
  );
}
