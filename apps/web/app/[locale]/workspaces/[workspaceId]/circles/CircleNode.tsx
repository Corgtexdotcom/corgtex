import { Handle, Position } from "@xyflow/react";

export type CircleNodeData = {
  circleId: string;
  name: string;
  purposeMd: string | null;
  maturityStage: string;
  roleCount: number;
  onExpand?: (circleId: string) => void;
};

export default function CircleNode({ data, selected }: { data: CircleNodeData; selected?: boolean }) {
  const getBadgeClass = (stage: string) => {
    switch (stage) {
      case "BUILDING_MUSCLE": return "badge-building-muscle";
      case "FULL_O2": return "badge-full-o2";
      default: return "badge-getting-started";
    }
  };

  const getStageLabel = (stage: string) => {
    switch (stage) {
      case "BUILDING_MUSCLE": return "Building Muscle";
      case "FULL_O2": return "Full O2";
      default: return "Getting Started";
    }
  };

  return (
    <div className={`circle-node ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
      <div className="circle-node-title-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="circle-node-title">{data.name}</div>
        {data.onExpand && (
          <button 
            type="button" 
            className="expand-btn" 
            onClick={(e) => { e.stopPropagation(); data.onExpand!(data.circleId); }}
            style={{ fontSize: "12px", background: "var(--bg-alt)", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", padding: "2px 6px", cursor: "pointer" }}
          >
            Expand
          </button>
        )}
      </div>
      {data.purposeMd && (
        <div className="circle-node-purpose">{data.purposeMd}</div>
      )}
      <div className="circle-node-footer">
        <span className={`circle-node-badge ${getBadgeClass(data.maturityStage)}`}>
          {getStageLabel(data.maturityStage)}
        </span>
        <span className="circle-node-roles">
          {data.roleCount} {data.roleCount === 1 ? "role" : "roles"}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: "hidden" }} />
    </div>
  );
}
