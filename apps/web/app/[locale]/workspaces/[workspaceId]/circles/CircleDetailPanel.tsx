"use client";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import PersonNode from "./PersonNode";
import {
  collectCircleMembers,
  countAccountabilities,
  type CircleGraphCircle,
} from "./circleGraphHelpers";

export default function CircleDetailPanel({
  open,
  circleId,
  treeData,
  onClose,
  isDemo
}: {
  open: boolean;
  circleId: string | null;
  treeData: CircleGraphCircle[];
  onClose: () => void;
  isDemo: boolean;
}) {
  const t = useTranslations("circles");
  function findCircle(id: string | null, nodes: CircleGraphCircle[]): CircleGraphCircle | null {
    if (!id) return null;
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = findCircle(id, node.childCircles ?? []);
      if (found) return found;
    }
    return null;
  }

  const circle = findCircle(circleId, treeData);
  const members = circle ? collectCircleMembers(circle) : [];
  const accountabilityCount = circle ? countAccountabilities(circle) : 0;

  return (
    <>
      <div className={`slide-over-overlay ${open ? "open" : ""}`} onClick={onClose} />
      <div className={`slide-over-panel ${open ? "open" : ""}`}>
        <div className="slide-over-header">
          <h2 className="slide-over-title">{circle ? t("circleTitle", { name: circle.name }) : t("circleDetailsTitle")}</h2>
          <button type="button" onClick={onClose} aria-label={t("closePanel")} className="circle-icon-button">
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>
        
        <div className="slide-over-content">
          {circle ? (
            <div className="stack">
              <div className="circle-detail-stats">
                <div><strong>{circle.roles?.length || 0}</strong><span>{t("rolesShort")}</span></div>
                <div><strong>{members.length}</strong><span>{t("membersShort")}</span></div>
                <div><strong>{accountabilityCount}</strong><span>{t("accountabilitiesShort")}</span></div>
                <div><strong>{circle.childCircles?.length || 0}</strong><span>{t("subcirclesShort")}</span></div>
              </div>

              {members.length > 0 && (
                <div>
                  <strong style={{ display: "block", marginBottom: 10 }}>{t("labelMembers", { count: members.length })}</strong>
                  <div className="circle-detail-people">
                    {members.map((member) => (
                      <PersonNode
                        key={member.memberId}
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
                      />
                    ))}
                  </div>
                </div>
              )}

              <div>
                <strong style={{ display: "block", marginBottom: 4 }}>{t("labelPurpose")}</strong>
                <p className="nr-excerpt" style={{ margin: 0 }}>{circle.purposeMd || t("noPurpose")}</p>
              </div>
              
              {circle.domainMd && (
                <div>
                  <strong style={{ display: "block", marginBottom: 4 }}>{t("labelDomain")}</strong>
                  <p className="nr-item-meta" style={{ margin: 0 }}>{circle.domainMd}</p>
                </div>
              )}

              <div>
                <strong style={{ display: "block", marginBottom: 4 }}>{t("labelMaturityStage")}</strong>
                <div style={{ padding: "8px 12px", background: "var(--bg-alt)", borderRadius: "var(--radius-sm)", fontSize: "0.85rem", display: "inline-block" }}>
                  {circle.maturityStage}
                </div>
              </div>

              <div>
                <strong style={{ display: "block", marginBottom: 16 }}>{t("labelRoles", { count: circle.roles?.length || 0 })}</strong>
                {!circle.roles?.length && <p className="nr-item-meta">{t("noRolesInCircle")}</p>}
                
                <div className="stack" style={{ gap: 12 }}>
                  {circle.roles?.map((role) => (
                    <div key={role.id} className="circle-detail-role">
                      <div className="circle-detail-role-header">
                        <strong>{role.name}</strong>
                        <span>
                          {(role.accountabilities?.length || 0) > 0
                            ? t("accountabilityCount", { count: role.accountabilities?.length || 0 })
                            : t("noAccountabilities")}
                        </span>
                      </div>
                      {role.purposeMd && <div className="nr-excerpt" style={{ fontSize: "0.8rem", marginTop: 4 }}>{role.purposeMd}</div>}
                      {(role.accountabilities?.length || 0) > 0 && (
                        <ul className="circle-detail-accountabilities">
                          {(role.accountabilities ?? []).slice(0, 4).map((accountability, accountabilityIndex) => (
                            <li key={`${role.id}-accountability-${accountabilityIndex}`}>{accountability}</li>
                          ))}
                        </ul>
                      )}
                      
                      <div style={{ marginTop: 12 }}>
                        <strong style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("labelAssignedTo")}</strong>
                        {(role.assignments?.length ?? 0) > 0 ? (
                          <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {(role.assignments ?? []).map((a: any) => (
                              a.member?.id ? (
                                <PersonNode
                                  key={a.id}
                                  person={{
                                    memberId: a.member.id,
                                    userId: a.member.user?.id,
                                    kind: a.member.kind,
                                    displayName: a.member.user?.displayName || a.member.user?.email || t("unknownMember"),
                                    email: a.member.user?.email || "",
                                    avatarUrl: a.member.user?.avatarUrl,
                                    bio: a.member.user?.bio,
                                    workspaceId: circle.workspaceId,
                                  }}
                                />
                              ) : null
                            ))}
                          </div>
                        ) : (
                          <div className="nr-item-meta" style={{ marginTop: 4 }}>{t("unassigned")}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              {!isDemo && (
                <div style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
                   <p className="muted" style={{ fontSize: "0.85rem" }}>{t("editPrompt")}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="muted">{t("selectCirclePrompt")}</p>
          )}
        </div>
      </div>
    </>
  );
}
