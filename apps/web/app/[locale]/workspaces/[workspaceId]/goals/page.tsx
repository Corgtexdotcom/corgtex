import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import {
  getGoalTree,
  getMyGoalSlice,
  listCircles,
  listGoals,
  listMembers,
  listRecognitions,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { GoalProgress } from "./GoalProgress";
import { RecognitionCard } from "./RecognitionCard";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { ActionMenu } from "@/lib/components/ui/ActionMenu";
import {
  addKeyResultFormAction,
  archiveGoalFormAction,
  createGoalFormAction,
  returnGoalToDraftFormAction,
  updateGoalFormAction,
} from "./actions";
import type { GoalCadence, GoalLevel, GoalStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const CADENCES: { id: GoalCadence; label: string }[] = [
  { id: "TEN_YEAR", label: "10Y" },
  { id: "FIVE_YEAR", label: "5Y" },
  { id: "ANNUAL", label: "Annual" },
  { id: "QUARTERLY", label: "Quarterly" },
  { id: "MONTHLY", label: "Monthly" },
  { id: "WEEKLY", label: "Weekly" },
];

const LEVELS: GoalLevel[] = ["COMPANY", "CIRCLE", "PERSONAL"];
const STATUSES: GoalStatus[] = ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND", "COMPLETED", "DRAFT", "ABANDONED"];

export default async function GoalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string; cadence?: string }>;
}) {
  const { workspaceId } = await params;
  await requireWorkspaceFeature(workspaceId, "GOALS");
  const { view = "tree", cadence = "QUARTERLY" } = await searchParams;
  const actor = await requirePageActor();
  const t = await getTranslations("goals");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const canManageAnyGoal = actor.kind === "agent" || membership?.role === "ADMIN";

  const [allGoals, circles, members] = await Promise.all([
    listGoals(actor, { workspaceId }),
    listCircles(workspaceId),
    listMembers(workspaceId),
  ]);

  let tree: any[] = [];
  let mySlice: any[] = [];
  let recognitions: any[] = [];

  if (view === "tree") {
    tree = await getGoalTree(actor, workspaceId, { cadence: cadence as GoalCadence });
  } else if (actor.kind === "user") {
    if (membership) {
      mySlice = await getMyGoalSlice(actor, membership.id, workspaceId);
      recognitions = await listRecognitions(actor, { workspaceId, recipientMemberId: membership.id });
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-3xl font-bold text-text">{t("title")}</h1>
          <p className="text-muted mt-1">{t("description")}</p>
        </div>

        <div className="flex mt-2 sm:mt-0 glass-panel rounded-lg overflow-hidden border border-line p-1">
          <a
            href={`/workspaces/${workspaceId}/goals?view=tree&cadence=${cadence}`}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              view === "tree" ? "bg-black text-white shadow-sm" : "text-muted hover:text-text"
            }`}
          >
            {t("treeView")}
          </a>
          <a
            href={`/workspaces/${workspaceId}/goals?view=slice&cadence=${cadence}`}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              view === "slice" ? "bg-black text-white shadow-sm" : "text-muted hover:text-text"
            }`}
          >
            {t("mySlice")}
          </a>
        </div>
      </div>

      {view === "tree" && (
        <section className="ws-section">
          <details>
            <summary className="nr-hide-marker" style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent)" }}>
              <span className="nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0 }}>
                {t("newGoalTitle")}
              </span>
            </summary>
            <form action={createGoalFormAction} className="stack nr-form-section">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label>
                {t("formTitle")}
                <input name="title" required />
              </label>
              <label>
                {t("formDescription")}
                <MarkdownEditor name="descriptionMd" rows={4} />
              </label>
              <div className="actions-inline">
                <label style={{ flex: 1 }}>
                  {t("formCadence")}
                  <select name="cadence" defaultValue={cadence}>
                    {CADENCES.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  {t("formLevel")}
                  <select name="level" defaultValue="COMPANY">
                    {LEVELS.map((level) => (
                      <option key={level} value={level}>{level}</option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  {t("formStatus")}
                  <select name="status" defaultValue="DRAFT">
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="actions-inline">
                <label style={{ flex: 1 }}>
                  {t("formStartDate")}
                  <input name="startDate" type="date" />
                </label>
                <label style={{ flex: 1 }}>
                  {t("formTargetDate")}
                  <input name="targetDate" type="date" />
                </label>
              </div>
              <div className="actions-inline">
                <label style={{ flex: 1 }}>
                  {t("formParentGoal")}
                  <select name="parentGoalId" defaultValue="">
                    <option value="">{t("formNone")}</option>
                    {allGoals.map((goal) => (
                      <option key={goal.id} value={goal.id}>{goal.title}</option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  {t("formCircle")}
                  <select name="circleId" defaultValue="">
                    <option value="">{t("formNone")}</option>
                    {circles.map((circle) => (
                      <option key={circle.id} value={circle.id}>{circle.name}</option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  {t("formOwner")}
                  <select name="ownerMemberId" defaultValue="">
                    <option value="">{t("formNone")}</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>{member.user.displayName ?? member.user.email}</option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset className="stack" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12 }}>
                <legend className="nr-meta" style={{ padding: "0 6px" }}>{t("formKeyResults")}</legend>
                {[0, 1, 2].map((index) => (
                  <div key={index} className="actions-inline">
                    <input name="keyResultTitle" placeholder={t("formKeyResultTitle")} />
                    <input name="keyResultCurrent" type="number" step="any" placeholder={t("formKeyResultCurrent")} style={{ width: 130 }} />
                    <input name="keyResultTarget" type="number" step="any" placeholder={t("formKeyResultTarget")} style={{ width: 130 }} />
                    <input name="keyResultUnit" placeholder={t("formKeyResultUnit")} style={{ width: 120 }} />
                  </div>
                ))}
              </fieldset>
              <button type="submit">{t("btnCreateGoal")}</button>
            </form>
          </details>
        </section>
      )}

      {view === "tree" && (
        <div className="space-y-6">
          <div className="flex overflow-x-auto pb-2 gap-2">
            {CADENCES.map((item) => (
              <a
                key={item.id}
                href={`/workspaces/${workspaceId}/goals?view=tree&cadence=${item.id}`}
                className={`px-3 py-1 text-sm font-medium rounded-full whitespace-nowrap transition-colors border ${
                  cadence === item.id
                    ? "bg-blue-50 text-blue-700 border-blue-200"
                    : "bg-surface-strong text-muted border-line hover:bg-surface-sunken"
                }`}
              >
                {item.label}
              </a>
            ))}
          </div>

          <div className="space-y-4">
            {tree.length === 0 ? (
              <div className="p-12 text-center text-muted bg-surface-strong rounded-xl border border-dashed border-line">
                {t("noGoalsFound", { cadence: cadence.toLowerCase().replace("_", "") })}
              </div>
            ) : (
              tree.map((goal) => (
                <GoalNode
                  key={goal.id}
                  workspaceId={workspaceId}
                  goal={goal}
                  level={0}
                  allGoals={allGoals}
                  circles={circles}
                  members={members}
                  canManageAnyGoal={canManageAnyGoal}
                  membershipId={membership?.id ?? null}
                />
              ))
            )}
          </div>
        </div>
      )}

      {view === "slice" && (
        <div className="space-y-8">
          <div>
            <h3 className="text-xl font-semibold mb-4 text-text">{t("myActiveGoals")}</h3>
            <div className="space-y-4">
              {mySlice.length === 0 ? (
                <div className="p-8 text-center text-muted bg-surface-strong rounded-xl border border-dashed border-line">
                  {t("noOwnedGoals")}
                </div>
              ) : (
                mySlice.map((goal) => (
                  <div key={goal.id} className="bg-surface-strong border border-line rounded-lg p-5 shadow-sm">
                    <div className="flex justify-between items-start mb-2">
                      <h4 className="font-semibold text-lg">{goal.title}</h4>
                      <span className="text-xs px-2 py-1 bg-accent-soft rounded text-muted">
                        {goal.cadence.replace("_", "")}
                      </span>
                    </div>
                    {goal.parentGoal && (
                      <div className="text-sm text-muted mb-3 flex items-center">
                        <span className="mr-1">↗ {t("contributesTo")}</span>
                        <span className="font-medium text-text">
                          {goal.parentGoal.circle?.name ? `[${goal.parentGoal.circle.name}] ` : ""}
                          {goal.parentGoal.title}
                        </span>
                      </div>
                    )}
                    <GoalProgress percent={goal.progressPercent} />
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h3 className="text-xl font-semibold mb-4 text-text">{t("recentRecognitions")}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {recognitions.length === 0 ? (
                <div className="col-span-full p-8 text-center text-muted bg-surface-strong rounded-xl border border-dashed border-line">
                  {t("noRecognitions")}
                </div>
              ) : (
                recognitions.map((rec) => (
                  <RecognitionCard key={rec.id} recognition={rec} />
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GoalNode({
  workspaceId,
  goal,
  level,
  allGoals,
  circles,
  members,
  canManageAnyGoal,
  membershipId,
}: {
  workspaceId: string;
  goal: any;
  level: number;
  allGoals: any[];
  circles: any[];
  members: any[];
  canManageAnyGoal: boolean;
  membershipId: string | null;
}) {
  return (
    <GoalNodeInner
      workspaceId={workspaceId}
      goal={goal}
      level={level}
      allGoals={allGoals}
      circles={circles}
      members={members}
      canManageAnyGoal={canManageAnyGoal}
      membershipId={membershipId}
    />
  );
}

function GoalNodeInner({
  workspaceId,
  goal,
  level,
  allGoals,
  circles,
  members,
  canManageAnyGoal,
  membershipId,
}: {
  workspaceId: string;
  goal: any;
  level: number;
  allGoals: any[];
  circles: any[];
  members: any[];
  canManageAnyGoal: boolean;
  membershipId: string | null;
}) {
  const t = useTranslations("goals");
  const tCommon = useTranslations("common");
  const canManage = canManageAnyGoal || (Boolean(goal.ownerMemberId) && goal.ownerMemberId === membershipId);
  const canReturnToDraft = ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"].includes(goal.status);
  return (
    <div className="border border-line rounded-lg bg-surface-strong shadow-sm overflow-hidden mb-3" style={{ marginLeft: `${level * 1.5}rem` }}>
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0 pr-4">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded uppercase ${
                goal.level === "COMPANY" ? "bg-purple-100 text-purple-800" :
                goal.level === "CIRCLE" ? "bg-blue-100 text-blue-800" :
                "bg-green-100 text-green-800"
              }`}>
                {goal.level}
              </span>
              <h3 className="text-base font-semibold text-text truncate">
                {goal.circle?.name ? `[${goal.circle.name}] ` : ""}{goal.title}
              </h3>
            </div>
            {goal.descriptionMd && (
              <MarkdownRenderer markdown={goal.descriptionMd} variant="compact" className="text-sm text-muted mt-1" />
            )}
            {goal.ownerMember && (
              <div className="text-sm text-muted flex items-center gap-1.5 mb-2 mt-2">
                {goal.ownerMember.user?.avatarUrl ? (
                  <span
                    aria-hidden="true"
                    className="w-4 h-4 rounded-full bg-center bg-cover"
                    style={{ backgroundImage: `url(${JSON.stringify(goal.ownerMember.user.avatarUrl)})` }}
                  />
                ) : (
                  <div className="w-4 h-4 rounded-full bg-accent-soft" />
                )}
                <span>{goal.ownerMember.user?.displayName || t("unknown")}</span>
              </div>
            )}
          </div>
          <div className="text-right flex-shrink-0 flex flex-col items-end">
            <span className="text-xs font-semibold px-2 py-1 bg-accent-soft text-text rounded">
              {goal.status}
            </span>
            {goal.targetDate && (
              <span className="text-xs mt-1 text-muted">
                {t("target")} {new Date(goal.targetDate).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-muted mb-1">
          <span>{t("overallProgress")}</span>
          <span className="font-medium text-text">{goal.progressPercent}%</span>
        </div>
        <GoalProgress percent={goal.progressPercent} />

        {goal.keyResults && goal.keyResults.length > 0 && (
          <div className="mt-4 pt-3 border-t border-line-subtle space-y-2">
            {goal.keyResults.map((kr: any) => (
              <div key={kr.id} className="text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                <span className="text-text flex-1">{kr.title}</span>
                <span className="text-muted text-xs font-mono ml-0 sm:ml-4 flex-shrink-0">
                  {kr.currentValue || 0} / {kr.targetValue || 0} {kr.unit || ""} ({kr.progressPercent}%)
                </span>
              </div>
            ))}
          </div>
        )}

        {canManage && (
        <div className="mt-4 pt-3 border-t border-line-subtle space-y-3">
          <div className="item-actions">
            <div className="item-actions-primary">
              {goal.status === "DRAFT" ? (
                <form action={updateGoalFormAction}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="goalId" value={goal.id} />
                  <input type="hidden" name="status" value="ACTIVE" />
                  <button type="submit" className="primary small">{t("btnOpen")}</button>
                </form>
              ) : (
                <form action={updateGoalFormAction} className="actions-inline">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="goalId" value={goal.id} />
                  <select name="status" defaultValue={goal.status} style={{ width: "auto" }} aria-label={t("formStatus")}>
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                  <input name="progressPercent" type="number" min={0} max={100} defaultValue={goal.progressPercent} style={{ width: 80 }} aria-label={t("formProgress")} />
                  <button type="submit" className="secondary small">{t("btnSaveGoal")}</button>
                </form>
              )}
            </div>
            <ActionMenu label={tCommon("moreActions")}>
              {canReturnToDraft && (
                <form action={returnGoalToDraftFormAction}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="goalId" value={goal.id} />
                  <button type="submit">{t("btnReturnToDraft")}</button>
                </form>
              )}
              {goal.status === "DRAFT" && (
                <details>
                  <summary className="nr-hide-marker" style={{ cursor: "pointer", padding: "8px 10px", borderRadius: 8, fontSize: "0.88rem", fontWeight: 500 }}>
                    {t("btnEdit")}
                  </summary>
                  <form action={updateGoalFormAction} className="action-menu-form">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="goalId" value={goal.id} />
                    <label>
                      {t("formTitle")}
                      <input name="title" defaultValue={goal.title} required />
                    </label>
                    <label>
                      {t("formDescription")}
                      <MarkdownEditor name="descriptionMd" defaultValue={goal.descriptionMd ?? ""} rows={4} />
                    </label>
                    <div className="actions-inline">
                      <label style={{ flex: 1 }}>
                        {t("formCadence")}
                        <select name="cadence" defaultValue={goal.cadence}>
                          {CADENCES.map((item) => (
                            <option key={item.id} value={item.id}>{item.label}</option>
                          ))}
                        </select>
                      </label>
                      <label style={{ flex: 1 }}>
                        {t("formLevel")}
                        <select name="level" defaultValue={goal.level}>
                          {LEVELS.map((item) => (
                            <option key={item} value={item}>{item}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="actions-inline">
                      <label style={{ flex: 1 }}>
                        {t("formStartDate")}
                        <input name="startDate" type="date" defaultValue={goal.startDate ? new Date(goal.startDate).toISOString().slice(0, 10) : ""} />
                      </label>
                      <label style={{ flex: 1 }}>
                        {t("formTargetDate")}
                        <input name="targetDate" type="date" defaultValue={goal.targetDate ? new Date(goal.targetDate).toISOString().slice(0, 10) : ""} />
                      </label>
                    </div>
                    <div className="actions-inline">
                      <label style={{ flex: 1 }}>
                        {t("formParentGoal")}
                        <select name="parentGoalId" defaultValue={goal.parentGoalId ?? ""}>
                          <option value="">{t("formNone")}</option>
                          {allGoals.filter((item) => item.id !== goal.id).map((item) => (
                            <option key={item.id} value={item.id}>{item.title}</option>
                          ))}
                        </select>
                      </label>
                      <label style={{ flex: 1 }}>
                        {t("formCircle")}
                        <select name="circleId" defaultValue={goal.circleId ?? ""}>
                          <option value="">{t("formNone")}</option>
                          {circles.map((circle) => (
                            <option key={circle.id} value={circle.id}>{circle.name}</option>
                          ))}
                        </select>
                      </label>
                      <label style={{ flex: 1 }}>
                        {t("formOwner")}
                        <select name="ownerMemberId" defaultValue={goal.ownerMemberId ?? ""}>
                          <option value="">{t("formNone")}</option>
                          {members.map((member) => (
                            <option key={member.id} value={member.id}>{member.user.displayName ?? member.user.email}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <button type="submit" className="secondary small">{t("btnSaveDraft")}</button>
                  </form>
                </details>
              )}
              {goal.status === "DRAFT" && (
                <details>
                  <summary className="nr-hide-marker" style={{ cursor: "pointer", padding: "8px 10px", borderRadius: 8, fontSize: "0.88rem", fontWeight: 500 }}>
                    {t("addKeyResultTitle")}
                  </summary>
                  <form action={addKeyResultFormAction} className="action-menu-form">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="goalId" value={goal.id} />
                    <input name="title" placeholder={t("formKeyResultTitle")} required />
                    <div className="actions-inline">
                      <input name="currentValue" type="number" step="any" placeholder={t("formKeyResultCurrent")} style={{ flex: 1 }} />
                      <input name="targetValue" type="number" step="any" placeholder={t("formKeyResultTarget")} style={{ flex: 1 }} />
                      <input name="unit" placeholder={t("formKeyResultUnit")} style={{ flex: 1 }} />
                    </div>
                    <button type="submit" className="secondary small">{t("btnAddKeyResult")}</button>
                  </form>
                </details>
              )}
              <div className="action-menu-divider" />
              <form action={archiveGoalFormAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="goalId" value={goal.id} />
                <button type="submit" className="danger">{t("btnArchiveGoal")}</button>
              </form>
            </ActionMenu>
          </div>
        </div>
        )}
      </div>

      {goal.childGoals && goal.childGoals.length > 0 && (
        <div className="bg-surface-sunken p-3 pt-4 border-t border-line">
          {goal.childGoals.map((child: any) => (
            <GoalNode
              key={child.id}
              workspaceId={workspaceId}
              goal={child}
              level={level + 1}
              allGoals={allGoals}
              circles={circles}
              members={members}
              canManageAnyGoal={canManageAnyGoal}
              membershipId={membershipId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
