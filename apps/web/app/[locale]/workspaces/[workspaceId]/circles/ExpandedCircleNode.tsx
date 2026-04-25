import { Handle, Position } from "@xyflow/react";
import PersonNode, { PersonData } from "./PersonNode";
import { useTranslations } from "next-intl";

export type ExpandedCircleNodeData = {
  circleId: string;
  workspaceId: string;
  name: string;
  purposeMd: string | null;
  maturityStage: string;
  roleCount: number;
  roles: any[];
  onCollapse: (circleId: string) => void;
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
    <div className={`circle-node expanded ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
      
      <div className="expanded-circle-header">
        <div className="expanded-circle-title-row">
          <div className="circle-node-title">{data.name}</div>
          <button 
            type="button" 
            className="collapse-btn" 
            onClick={(e) => { e.stopPropagation(); data.onCollapse(data.circleId); }}
          >{t("btnCollapse")}</button>
        </div>
        {data.purposeMd && (
          <div className="circle-node-purpose">{data.purposeMd}</div>
        )}
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
          return (
            <div key={role.id} className="role-card">
              <div className="role-card-header">
                <strong>{role.name}</strong>
              </div>
              
              <div className="role-card-people">
                {assignments.length === 0 && (
                  <span className="unassigned-text">{t("unassigned")}</span>
                )}
                {assignments.map((assignment: any) => {
                  const personData: PersonData = {
                    memberId: assignment.member.id,
                    userId: assignment.member.user.id,
                    displayName: assignment.member.user.displayName || assignment.member.user.email,
                    email: assignment.member.user.email,
                    roleName: role.name,
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
