import { Handle, Position } from "@xyflow/react";
import { Minimize2 } from "lucide-react";
import PersonNode from "./PersonNode";
import type { PersonData } from "./PersonNode";
import { useTranslations } from "next-intl";
import type { CircleGraphRole, CircleMemberPreview } from "./circleGraphHelpers";

export type ExpandedCircleNodeData = {
  circleId: string;
  workspaceId: string;
  name: string;
  purposeMd: string | null;
  domainMd?: string | null;
  maturityStage: string;
  roleCount: number;
  memberCount: number;
  childCircleCount: number;
  accountabilityCount: number;
  members: CircleMemberPreview[];
  roles: CircleGraphRole[];
  onCollapse: (circleId: string) => void;
  nodeWidth?: number;
  nodeHeight?: number;
};

export default function ExpandedCircleNode({ data, selected }: { data: ExpandedCircleNodeData; selected?: boolean }) {
  const t = useTranslations("circles");
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
      className={`circle-node expanded ${selected ? "selected" : ""}`}
      style={{ width: data.nodeWidth, height: data.nodeHeight }}
    >
      <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
      
      <div className="expanded-circle-header">
        <div className="expanded-circle-title-row">
          <div className="circle-node-title">{data.name}</div>
          <button 
            type="button" 
            className="circle-icon-button nodrag nopan"
            onClick={(e) => { e.stopPropagation(); data.onCollapse(data.circleId); }}
            aria-label={t("btnCollapse")}
            title={t("btnCollapse")}
          >
            <Minimize2 size={14} strokeWidth={1.8} />
          </button>
        </div>
        {data.purposeMd && <div className="circle-node-purpose">{data.purposeMd}</div>}
        <div className="expanded-circle-roster">
          {data.members.slice(0, 8).map((member) => (
            <PersonNode
              key={member.memberId}
              compact
              person={{
                memberId: member.memberId,
                userId: member.userId,
                displayName: member.displayName,
                email: member.email,
                avatarUrl: member.avatarUrl,
                bio: member.bio,
                roleName: member.roleNames.join(", "),
                workspaceId: member.workspaceId,
              }}
            />
          ))}
          {data.memberCount > 8 && (
            <span className="person-overflow">+{data.memberCount - 8}</span>
          )}
        </div>
        <div className="circle-node-metrics expanded-metrics">
          <span><strong>{data.memberCount}</strong>{t("membersShort")}</span>
          <span><strong>{data.accountabilityCount}</strong>{t("accountabilitiesShort")}</span>
          <span><strong>{data.childCircleCount}</strong>{t("subcirclesShort")}</span>
        </div>
        <div className="circle-node-footer">
          <span className={`circle-node-badge ${getBadgeClass(data.maturityStage)}`}>
            {getStageLabel(data.maturityStage)}
          </span>
          <span className="circle-node-roles">
            {data.roleCount === 1 ? t("roleCountSingle", { count: data.roleCount }) : t("roleCountPlural", { count: data.roleCount })}
          </span>
        </div>
      </div>

      <div className="expanded-circle-content">
        {data.roles?.length === 0 && (
          <div className="empty-roles">{t("emptyRoles")}</div>
        )}
        
        {data.roles?.map((role) => {
          const assignments = role.assignments || [];
          const accountabilities = role.accountabilities || [];
          return (
            <div key={role.id} className="role-card">
              <div className="role-card-header">
                <strong>{role.name}</strong>
                <span>
                  {accountabilities.length > 0
                    ? t("accountabilityCount", { count: accountabilities.length })
                    : t("noAccountabilities")}
                </span>
              </div>
              {role.purposeMd && <div className="role-card-purpose">{role.purposeMd}</div>}
              {accountabilities.length > 0 && (
                <ul className="role-card-accountabilities">
                  {accountabilities.slice(0, 2).map((accountability) => (
                    <li key={accountability}>{accountability}</li>
                  ))}
                </ul>
              )}
              
              <div className="role-card-people">
                {assignments.length === 0 && (
                  <span className="unassigned-text">{t("unassigned")}</span>
                )}
                {assignments.map((assignment: any) => {
                  const member = assignment.member;
                  const user = member?.user;
                  if (!member?.id) return null;
                  const personData: PersonData = {
                    memberId: member.id,
                    userId: user?.id,
                    displayName: user?.displayName || user?.email || t("unknownMember"),
                    email: user?.email || "",
                    roleName: role.name,
                    avatarUrl: user?.avatarUrl,
                    bio: user?.bio,
                    workspaceId: data.workspaceId,
                  };
                  return <PersonNode key={assignment.id} person={personData} />;
                })}
              </div>
            </div>
          );
        })}
      </div>

      <Handle type="source" position={Position.Bottom} style={{ visibility: "hidden" }} />
    </div>
  );
}
