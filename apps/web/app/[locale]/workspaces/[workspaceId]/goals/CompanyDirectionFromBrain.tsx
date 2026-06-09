import { useTranslations } from "next-intl";
import type {
  CompanyDirectionEvidenceLink,
  CompanyDirectionFromBrain as CompanyDirectionFromBrainData,
  CompanyDirectionGoal,
  CompanyDirectionQuestion,
} from "@corgtex/domain";
import type { GoalCadence, GoalStatus } from "@prisma/client";

import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import {
  answerCompanyUnderstandingQuestionFormAction,
  refreshCompanyDirectionFromBrainFormAction,
  returnGoalToDraftFormAction,
  skipCompanyUnderstandingQuestionFormAction,
  updateGoalFormAction,
} from "./actions";

const EDIT_CADENCES: { id: GoalCadence; label: string }[] = [
  { id: "TEN_YEAR", label: "10Y" },
  { id: "FIVE_YEAR", label: "5Y" },
  { id: "ANNUAL", label: "Annual" },
  { id: "QUARTERLY", label: "Quarterly" },
  { id: "MONTHLY", label: "Monthly" },
  { id: "WEEKLY", label: "Weekly" },
];

const EDIT_STATUSES: GoalStatus[] = ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND", "COMPLETED", "DRAFT", "ABANDONED"];

function formatConfidence(value: number | null) {
  if (value === null) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function evidenceHref(workspaceId: string, evidence: { entityType: string; articleSlug: string | null }) {
  if (evidence.entityType === "BrainArticle" && evidence.articleSlug) {
    return `/workspaces/${workspaceId}/brain/${evidence.articleSlug}`;
  }
  if (evidence.entityType === "BrainSource") {
    return `/workspaces/${workspaceId}/brain/sources`;
  }
  return `/workspaces/${workspaceId}/brain`;
}

function CompanyDirectionEvidenceList({
  workspaceId,
  links,
}: {
  workspaceId: string;
  links: CompanyDirectionEvidenceLink[];
}) {
  const t = useTranslations("goals");
  if (links.length === 0) {
    return <p className="text-xs text-muted mt-3">{t("companyDirectionNoEvidence")}</p>;
  }

  return (
    <div className="mt-4 pt-3 border-t border-line-subtle space-y-2">
      <div className="text-xs uppercase font-semibold text-muted">{t("companyDirectionEvidence")}</div>
      {links.map((link) => (
        <div key={link.id} className="text-sm">
          <a href={evidenceHref(workspaceId, link)} className="font-medium text-text underline-offset-2 hover:underline">
            {link.label}
          </a>
          <span className="text-xs text-muted"> - {link.detail ?? link.entityType} - {formatConfidence(link.confidence)}</span>
          {link.quote && <div className="text-xs text-muted mt-1">{link.quote}</div>}
        </div>
      ))}
    </div>
  );
}

function DirectionGoalCard({
  workspaceId,
  goal,
  canManage,
}: {
  workspaceId: string;
  goal: CompanyDirectionGoal;
  canManage: boolean;
}) {
  const t = useTranslations("goals");
  const tCommon = useTranslations("common");
  const canReturnToDraft = ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"].includes(goal.status);

  return (
    <article className="border border-line rounded-lg bg-surface-strong p-4 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded uppercase bg-accent-soft text-text">
              {goal.cadence.replace("_", " ")}
            </span>
            <span className="text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded uppercase bg-surface-sunken text-muted">
              {goal.status}
            </span>
          </div>
          <h4 className="text-base font-semibold text-text">{goal.title}</h4>
          {goal.descriptionMd && (
            <MarkdownRenderer markdown={goal.descriptionMd} variant="compact" className="text-sm text-muted mt-2" />
          )}
        </div>
        <div className="text-left sm:text-right flex-shrink-0">
          <div className="text-xs uppercase font-semibold text-muted">{t("companyDirectionConfidence")}</div>
          <div className="text-lg font-semibold text-text">{formatConfidence(goal.confidence)}</div>
        </div>
      </div>

      <CompanyDirectionEvidenceList workspaceId={workspaceId} links={goal.evidenceLinks} />

      {canManage && (
        <div className="mt-4 pt-3 border-t border-line-subtle flex flex-wrap items-center gap-2">
          {goal.status === "DRAFT" && (
            <form action={updateGoalFormAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="goalId" value={goal.id} />
              <input type="hidden" name="status" value="ACTIVE" />
              <button type="submit" className="primary small">{t("companyDirectionAccept")}</button>
            </form>
          )}
          {canReturnToDraft && (
            <form action={returnGoalToDraftFormAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="goalId" value={goal.id} />
              <button type="submit" className="secondary small">{t("btnReturnToDraft")}</button>
            </form>
          )}
          <details>
            <summary className="secondary small nr-hide-marker" style={{ cursor: "pointer" }}>
              {t("btnEdit")}
            </summary>
            <form action={updateGoalFormAction} className="stack nr-form-section" style={{ marginTop: 12, minWidth: "min(680px, 100%)" }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="goalId" value={goal.id} />
              <label>
                {t("formTitle")}
                <input name="title" defaultValue={goal.title} required />
              </label>
              <label>
                {t("formDescription")}
                <MarkdownEditor name="descriptionMd" defaultValue={goal.descriptionMd ?? ""} rows={3} />
              </label>
              <div className="actions-inline">
                <label style={{ flex: 1 }}>
                  {t("formCadence")}
                  <select name="cadence" defaultValue={goal.cadence}>
                    {EDIT_CADENCES.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  {t("formStatus")}
                  <select name="status" defaultValue={goal.status}>
                    {EDIT_STATUSES.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="submit" className="secondary small">{tCommon("save")}</button>
            </form>
          </details>
        </div>
      )}
    </article>
  );
}

function DirectionGoalGroup({
  workspaceId,
  title,
  description,
  goals,
  canManage,
}: {
  workspaceId: string;
  title: string;
  description: string;
  goals: CompanyDirectionGoal[];
  canManage: boolean;
}) {
  const t = useTranslations("goals");
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-text">{title}</h3>
        <p className="text-sm text-muted">{description}</p>
      </div>
      {goals.length === 0 ? (
        <div className="p-5 text-sm text-muted bg-surface-sunken border border-dashed border-line rounded-lg">
          {t("companyDirectionNoGoals")}
        </div>
      ) : (
        goals.map((goal) => (
          <DirectionGoalCard key={goal.id} workspaceId={workspaceId} goal={goal} canManage={canManage} />
        ))
      )}
    </div>
  );
}

function DirectionQuestionCard({
  workspaceId,
  question,
}: {
  workspaceId: string;
  question: CompanyDirectionQuestion;
}) {
  const t = useTranslations("goals");
  return (
    <article className="border border-line rounded-lg bg-surface-strong p-4 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h4 className="text-base font-semibold text-text">{question.questionText}</h4>
          {question.reason && <p className="text-sm text-muted mt-1">{question.reason}</p>}
          {question.relatedEvidence && (
            <a
              href={evidenceHref(workspaceId, question.relatedEvidence)}
              className="inline-block text-xs text-muted underline-offset-2 hover:underline mt-2"
            >
              {question.relatedEvidence.label}
            </a>
          )}
        </div>
        <div className="text-left sm:text-right flex-shrink-0">
          <div className="text-xs uppercase font-semibold text-muted">{t("companyDirectionConfidence")}</div>
          <div className="text-lg font-semibold text-text">{formatConfidence(question.confidence)}</div>
        </div>
      </div>
      <p className="text-xs text-muted mt-4">{t("companyDirectionQuestionPolicy")}</p>
      <form action={answerCompanyUnderstandingQuestionFormAction} className="stack mt-3">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="checkInId" value={question.id} />
        <label>
          {t("companyDirectionAnswerLabel")}
          <textarea name="responseMd" rows={3} required />
        </label>
        <button type="submit" className="primary small">{t("companyDirectionAnswer")}</button>
      </form>
      <form action={skipCompanyUnderstandingQuestionFormAction} className="mt-2">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="checkInId" value={question.id} />
        <button type="submit" className="secondary small">{t("companyDirectionSkip")}</button>
      </form>
    </article>
  );
}

export function CompanyDirectionFromBrain({
  workspaceId,
  direction,
  canManageGoals,
  canRefreshFromBrain,
}: {
  workspaceId: string;
  direction: CompanyDirectionFromBrainData;
  canManageGoals: boolean;
  canRefreshFromBrain: boolean;
}) {
  const t = useTranslations("goals");
  const returnTo = `/workspaces/${workspaceId}/goals`;
  const uploadHref = `/workspaces/${workspaceId}/add?kind=upload_file&returnTo=${encodeURIComponent(returnTo)}`;
  const pasteHref = `/workspaces/${workspaceId}/add?kind=paste_text&returnTo=${encodeURIComponent(returnTo)}`;
  const hasAnyGeneratedDirection = direction.generatedGoalCount > 0 || direction.openQuestions.length > 0;

  return (
    <section className="ws-section space-y-5" data-testid="company-direction-from-brain">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-text">{t("companyDirectionTitle")}</h2>
          <p className="text-sm text-muted mt-1">{t("companyDirectionDescription")}</p>
          <div className="flex flex-wrap gap-2 mt-3 text-xs text-muted">
            <span className="tag">{t("companyDirectionGoalCount", { count: direction.generatedGoalCount })}</span>
            <span className="tag">{t("companyDirectionEvidenceCount", { count: direction.evidenceLinkCount })}</span>
            <span className="tag">{t("companyDirectionQuestionCount", { count: direction.openQuestions.length })}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canRefreshFromBrain && (
            <form action={refreshCompanyDirectionFromBrainFormAction}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <button type="submit" className="primary small">{t("companyDirectionRefresh")}</button>
            </form>
          )}
          <a href={uploadHref} className="secondary small">{t("companyDirectionUploadEvidence")}</a>
          <a href={pasteHref} className="secondary small">{t("companyDirectionPasteEvidence")}</a>
        </div>
      </div>

      {!hasAnyGeneratedDirection && (
        <div className="p-6 text-sm text-muted bg-surface-sunken border border-dashed border-line rounded-lg">
          {t("companyDirectionEmpty")}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <DirectionGoalGroup
          workspaceId={workspaceId}
          title={t("companyDirectionDecisionsNow")}
          description={t("companyDirectionDecisionsNowDescription")}
          goals={direction.decisionsNow}
          canManage={canManageGoals}
        />
        <DirectionGoalGroup
          workspaceId={workspaceId}
          title={t("companyDirectionStrategyLater")}
          description={t("companyDirectionStrategyLaterDescription")}
          goals={direction.strategyLater}
          canManage={canManageGoals}
        />
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold text-text">{t("companyDirectionOpenQuestions")}</h3>
          <p className="text-sm text-muted">{t("companyDirectionOpenQuestionsDescription")}</p>
        </div>
        {direction.openQuestions.length === 0 ? (
          <div className="p-5 text-sm text-muted bg-surface-sunken border border-dashed border-line rounded-lg">
            {t("companyDirectionNoQuestions")}
          </div>
        ) : (
          direction.openQuestions.map((question) => (
            <DirectionQuestionCard key={question.id} workspaceId={workspaceId} question={question} />
          ))
        )}
      </div>
    </section>
  );
}
