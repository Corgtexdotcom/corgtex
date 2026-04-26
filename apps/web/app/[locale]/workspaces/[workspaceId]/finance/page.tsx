import { Fragment } from "react";
import Link from "next/link";
import { listDeliberationEntries, listLedgerAccounts, listSpends } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
import { getTranslations } from "next-intl/server";
import {
  archiveLedgerAccountAction,
  archiveSpendAction,
  createLedgerAccountAction,
  createSpendAction,
  escalateSpendToProposalAction,
  linkSpendLedgerAccountAction,
  markSpendPaidAction,
  postSpendDeliberationAction,
  resolveSpendDeliberationAction,
  submitSpendAction,
  updateLedgerAccountAction,
  updateSpendReconciliationAction,
  uploadSpendStatementAction,
} from "../actions";

export const dynamic = "force-dynamic";

const spendFilters = ["ALL", "DRAFT", "OPEN", "BLOCKED", "RESOLVED", "PAID", "RECONCILED"] as const;
type SpendFilter = (typeof spendFilters)[number];

function fmt(cents: number, currency: string = "USD") {
  const abs = Math.abs(cents / 100);
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function normalizeFilter(value: string | string[] | undefined): SpendFilter {
  if (typeof value !== "string") return "ALL";
  return spendFilters.includes(value as SpendFilter) ? (value as SpendFilter) : "ALL";
}

function outcomeLabel(outcome?: string | null) {
  return outcome ? outcome.replace("_", " ") : null;
}

export default async function FinancePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("finance");
  const resolvedSearch = searchParams ? await searchParams : {};
  const activeTab = typeof resolvedSearch.tab === "string" ? resolvedSearch.tab : "spends";
  const statusFilter = normalizeFilter(resolvedSearch.status);
  const activeDiscussionId = typeof resolvedSearch.discuss === "string" ? resolvedSearch.discuss : null;

  const [spendsResult, ledgerAccountsResult, currentWorkspace, deliberationTargets] = await Promise.all([
    listSpends(workspaceId, { take: 200 }),
    listLedgerAccounts(workspaceId, { take: 50 }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    getDeliberationTargets({ actor, workspaceId }),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";
  const spends = spendsResult.items;
  const ledgerAccounts = ledgerAccountsResult.items;

  const entriesMap = new Map(
    await Promise.all(
      spends.map(async (spend) => {
        const entries = await listDeliberationEntries(actor, {
          workspaceId,
          parentType: "SPEND",
          parentId: spend.id,
        });
        return [spend.id, entries] as const;
      }),
    ),
  );

  const unresolvedObjectionCount = (spendId: string) => (
    (entriesMap.get(spendId) || []).filter((entry) => entry.entryType === "OBJECTION" && !entry.resolvedAt).length
  );
  const isBlocked = (spendId: string) => unresolvedObjectionCount(spendId) > 0;
  const isPaid = (spend: { spentAt?: Date | null }) => Boolean(spend.spentAt);

  const totalOpen = spends.filter((spend) => spend.status === "OPEN").reduce((sum, spend) => sum + spend.amountCents, 0);
  const totalApproved = spends
    .filter((spend) => spend.status === "RESOLVED" && spend.resolutionOutcome === "APPROVED")
    .reduce((sum, spend) => sum + spend.amountCents, 0);
  const totalPaid = spends.filter(isPaid).reduce((sum, spend) => sum + spend.amountCents, 0);
  const totalAll = spends.reduce((sum, spend) => sum + spend.amountCents, 0);

  const statusCounts: Record<SpendFilter, number> = {
    ALL: spends.length,
    DRAFT: spends.filter((spend) => spend.status === "DRAFT").length,
    OPEN: spends.filter((spend) => spend.status === "OPEN").length,
    BLOCKED: spends.filter((spend) => isBlocked(spend.id)).length,
    RESOLVED: spends.filter((spend) => spend.status === "RESOLVED").length,
    PAID: spends.filter(isPaid).length,
    RECONCILED: spends.filter((spend) => spend.reconciliationStatus === "RECONCILED").length,
  };

  const filteredSpends = spends.filter((spend) => {
    if (statusFilter === "ALL") return true;
    if (statusFilter === "BLOCKED") return isBlocked(spend.id);
    if (statusFilter === "PAID") return isPaid(spend);
    if (statusFilter === "RECONCILED") return spend.reconciliationStatus === "RECONCILED";
    return spend.status === statusFilter;
  });

  const filterLabel = (filter: SpendFilter) => {
    const labels: Record<SpendFilter, string> = {
      ALL: t("filterAll"),
      DRAFT: t("statusDraft"),
      OPEN: t("statusOpen"),
      BLOCKED: t("statusBlocked"),
      RESOLVED: t("statusResolved"),
      PAID: t("statusPaid"),
      RECONCILED: t("statusReconciled"),
    };
    return labels[filter];
  };

  const tabs = [
    { key: "spends", label: t("tabSpends") },
    { key: "accounts", label: t("tabAccounts") },
  ];

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 24 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      <div className="nr-stat-bar">
        <span className="nr-stat">{t("statTotal", { amount: fmt(totalAll) })}</span>
        <span className="nr-stat-sep">·</span>
        <span className="nr-stat" style={{ color: "var(--warning)" }}>{t("statOpen", { amount: fmt(totalOpen) })}</span>
        <span className="nr-stat-sep">·</span>
        <span className="nr-stat">{t("statApproved", { amount: fmt(totalApproved) })}</span>
        <span className="nr-stat-sep">·</span>
        <span className="nr-stat" style={{ color: "var(--success)" }}>{t("statPaid", { amount: fmt(totalPaid) })}</span>
        <span className="nr-stat-sep">·</span>
        <span className="nr-stat">{t("statAccounts", { count: ledgerAccounts.length })}</span>
      </div>

      <div className="nr-tab-bar">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={`?tab=${tab.key}`}
            className={`nr-tab ${activeTab === tab.key ? "nr-tab-active" : ""}`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {ledgerAccounts.length > 0 && (
        <div className="fin-account-chips">
          {ledgerAccounts.map((account) => (
            <div key={account.id} className="fin-account-chip">
              <span className="fin-chip-name">{account.name}</span>
              <span className="fin-chip-balance">{fmt(account.balanceCents, account.currency)}</span>
              <span className="fin-chip-type">{account.type}</span>
            </div>
          ))}
        </div>
      )}

      {activeTab === "spends" && (
        <section style={{ marginTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h2 className="nr-section-header" style={{ margin: 0 }}>{t("tabSpends")}</h2>
            {!isDemo && (
              <details className="fin-inline-create" style={{ position: "relative" }}>
                <summary className="button button-primary" style={{ cursor: "pointer", listStyle: "none" }}>{t("btnAddSpend")}</summary>
                <div className="fin-dropdown" style={{ right: 0, minWidth: "320px", marginTop: "8px" }}>
                  <form action={createSpendAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <label>
                      {t("colAmount")}
                      <input name="amount" type="number" step="0.01" min="0.01" required />
                    </label>
                    <div className="actions-inline">
                      <label style={{ flex: 1 }}>
                        {t("formCurrency")}
                        <input name="currency" defaultValue="USD" required />
                      </label>
                      <label style={{ flex: 1 }}>
                        {t("formCategory")}
                        <input name="category" required />
                      </label>
                    </div>
                    <label>
                      {t("formDescription")}
                      <textarea name="description" required />
                    </label>
                    <label>
                      {t("colVendor")}
                      <input name="vendor" />
                    </label>
                    <label>
                      {t("formLedgerAccount")}
                      <select name="ledgerAccountId" defaultValue="">
                        <option value="">{t("unassigned")}</option>
                        {ledgerAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.name} ({account.currency})</option>
                        ))}
                      </select>
                    </label>
                    <button type="submit">{t("btnCreateSpend")}</button>
                  </form>
                </div>
              </details>
            )}
          </div>

          <div className="nr-filter-bar">
            {spendFilters.map((filter) => (
              <Link
                key={filter}
                href={`?tab=spends&status=${filter}`}
                className={`nr-filter-item ${statusFilter === filter ? "nr-filter-active" : ""}`}
              >
                {filterLabel(filter)} ({statusCounts[filter]})
              </Link>
            ))}
          </div>

          {filteredSpends.length === 0 && <p className="muted" style={{ fontSize: "0.85rem", marginTop: 16 }}>{t("noSpends")}</p>}

          {filteredSpends.length > 0 && (
            <div className="nr-table-wrap">
              <table className="nr-table">
                <thead>
                  <tr>
                    <th>{t("colDate")}</th>
                    <th>{t("formCategory")}</th>
                    <th>{t("colDescription")}</th>
                    <th>{t("colVendor")}</th>
                    <th style={{ textAlign: "right" }}>{t("colAmount")}</th>
                    <th>{t("colStatus")}</th>
                    <th>{t("colAccount")}</th>
                    <th>{t("colReconciled")}</th>
                    {!isDemo && <th>{t("colActions")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredSpends.map((spend) => {
                    const entries = entriesMap.get(spend.id) || [];
                    const objectionCount = unresolvedObjectionCount(spend.id);
                    const canPay = !spend.spentAt && (
                      (spend.status === "OPEN" && objectionCount === 0) ||
                      (spend.status === "RESOLVED" && spend.resolutionOutcome === "APPROVED")
                    );
                    const discussionHref = activeDiscussionId === spend.id
                      ? `?tab=spends&status=${statusFilter}`
                      : `?tab=spends&status=${statusFilter}&discuss=${spend.id}`;

                    return (
                      <Fragment key={spend.id}>
                        <tr>
                          <td className="fin-td-date">
                            {new Date(spend.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          </td>
                          <td>{spend.category}</td>
                          <td className="fin-td-desc">{spend.description}</td>
                          <td>{spend.vendor || "—"}</td>
                          <td style={{ textAlign: "right", fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace" }}>
                            {fmt(spend.amountCents, spend.currency)}
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                              <span className={`fin-status-badge fin-status-${spend.status.toLowerCase()}`}>
                                {filterLabel(spend.status as SpendFilter)}
                              </span>
                              {spend.resolutionOutcome && (
                                <span className={`tag ${spend.resolutionOutcome === "REJECTED" ? "danger" : "success"}`}>
                                  {outcomeLabel(spend.resolutionOutcome)}
                                </span>
                              )}
                              {objectionCount > 0 && (
                                <span className="tag danger">{t("blockedCount", { count: objectionCount })}</span>
                              )}
                              {spend.spentAt && <span className="tag success">{t("statusPaid")}</span>}
                            </div>
                          </td>
                          <td className="fin-td-account">
                            {spend.ledgerAccount ? spend.ledgerAccount.name : "—"}
                          </td>
                          <td>
                            <span className={`fin-recon-badge fin-recon-${spend.reconciliationStatus.toLowerCase()}`}>
                              {spend.reconciliationStatus === "PENDING" ? "—" : spend.reconciliationStatus.replace("_", " ")}
                            </span>
                          </td>
                          {!isDemo && (
                            <td className="fin-td-actions">
                              {spend.status === "DRAFT" && (
                                <form action={submitSpendAction} style={{ display: "inline" }}>
                                  <input type="hidden" name="workspaceId" value={workspaceId} />
                                  <input type="hidden" name="spendId" value={spend.id} />
                                  <button type="submit" className="fin-action-btn">{t("btnOpen")}</button>
                                </form>
                              )}
                              <Link href={discussionHref} className="fin-action-btn">
                                {activeDiscussionId === spend.id ? t("btnCloseDiscussion") : t("btnDiscuss")}
                              </Link>
                              <details style={{ display: "inline-block" }}>
                                <summary className="fin-action-btn" style={{ cursor: "pointer" }}>{t("btnEdit")}</summary>
                                <div className="fin-dropdown" style={{ width: 320, padding: "16px" }}>
                                  {canPay && (
                                    <form action={markSpendPaidAction} className="fin-dropdown-form">
                                      <input type="hidden" name="workspaceId" value={workspaceId} />
                                      <input type="hidden" name="spendId" value={spend.id} />
                                      <input
                                        name="receiptUrl"
                                        placeholder={t("placeholderReceiptUrl")}
                                        defaultValue={spend.receiptUrl ?? ""}
                                        required
                                      />
                                      <button type="submit" className="fin-action-btn fin-action-pay">{t("btnMarkPaid")}</button>
                                    </form>
                                  )}
                                  <form action={linkSpendLedgerAccountAction} className="fin-dropdown-form">
                                    <input type="hidden" name="workspaceId" value={workspaceId} />
                                    <input type="hidden" name="spendId" value={spend.id} />
                                    <select name="ledgerAccountId" defaultValue={spend.ledgerAccountId ?? ""}>
                                      <option value="">{t("unlinked")}</option>
                                      {ledgerAccounts.map((account) => (
                                        <option key={account.id} value={account.id}>{account.name}</option>
                                      ))}
                                    </select>
                                    <button type="submit" className="fin-action-btn">{t("btnLink")}</button>
                                  </form>
                                  {spend.spentAt && (
                                    <>
                                      <form action={uploadSpendStatementAction} className="fin-dropdown-form">
                                        <input type="hidden" name="workspaceId" value={workspaceId} />
                                        <input type="hidden" name="spendId" value={spend.id} />
                                        <input
                                          name="storageKey"
                                          placeholder={t("placeholderStorageKey")}
                                          defaultValue={spend.statementStorageKey ?? ""}
                                          required
                                        />
                                        <input name="fileName" placeholder={t("placeholderFileName")} defaultValue={spend.statementFileName ?? ""} />
                                        <input name="mimeType" placeholder={t("placeholderMimeType")} defaultValue={spend.statementMimeType ?? ""} />
                                        <button type="submit" className="fin-action-btn">{t("btnAttachStatement")}</button>
                                      </form>
                                      <form action={updateSpendReconciliationAction} className="fin-dropdown-form">
                                        <input type="hidden" name="workspaceId" value={workspaceId} />
                                        <input type="hidden" name="spendId" value={spend.id} />
                                        <select name="status" defaultValue={spend.reconciliationStatus}>
                                          <option value="PENDING">{t("statusPending")}</option>
                                          <option value="STATEMENT_ATTACHED">{t("statusStatement")}</option>
                                          <option value="RECONCILED">{t("statusReconciled")}</option>
                                        </select>
                                        <input name="note" placeholder={t("placeholderNote")} defaultValue={spend.reconciliationNote ?? ""} />
                                        <button type="submit" className="fin-action-btn">{t("btnSave")}</button>
                                      </form>
                                    </>
                                  )}
                                  <form action={archiveSpendAction} className="fin-dropdown-form">
                                    <input type="hidden" name="workspaceId" value={workspaceId} />
                                    <input type="hidden" name="spendId" value={spend.id} />
                                    <button type="submit" className="fin-action-btn" style={{ color: "#842029" }}>{t("btnArchiveSpend")}</button>
                                  </form>
                                </div>
                              </details>
                            </td>
                          )}
                        </tr>
                        {activeDiscussionId === spend.id && (
                          <tr>
                            <td colSpan={isDemo ? 8 : 9} className="fin-discussion-cell">
                              <div className="fin-discussion-panel">
                                <DeliberationThread
                                  entries={entries.map((entry) => ({
                                    id: entry.id,
                                    entryType: entry.entryType,
                                    authorName: entry.author?.displayName || entry.author?.email || t("unknownAuthor"),
                                    authorInitials: (entry.author?.displayName || entry.author?.email || "?").substring(0, 2).toUpperCase(),
                                    bodyMd: entry.bodyMd,
                                    createdAt: entry.createdAt,
                                    resolvedAt: entry.resolvedAt,
                                    resolvedNote: entry.resolvedNote,
                                    targetLabel: entry.targetCircle
                                      ? `Circle: ${entry.targetCircle.name}`
                                      : entry.targetMember
                                        ? `Person: ${entry.targetMember.user.displayName || entry.targetMember.user.email}`
                                        : null,
                                  }))}
                                  canResolve
                                  resolveAction={resolveSpendDeliberationAction}
                                  hiddenFields={{ workspaceId, parentId: spend.id }}
                                />
                                {spend.status === "OPEN" && (
                                  <DeliberationComposer
                                    postAction={postSpendDeliberationAction}
                                    hiddenFields={{ workspaceId, parentId: spend.id }}
                                    title={t("discussionTitle")}
                                    targetOptions={deliberationTargets.options}
                                    defaultTargetValue={deliberationTargets.defaultValue}
                                    entryTypes={[
                                      { value: "REACTION", label: t("typeReaction"), variant: "secondary" },
                                      { value: "OBJECTION", label: t("typeObjection"), variant: "danger" },
                                    ]}
                                  />
                                )}
                                {objectionCount > 0 && (
                                  <form action={escalateSpendToProposalAction} className="fin-dropdown-form" style={{ marginTop: 16, maxWidth: 260 }}>
                                    <input type="hidden" name="workspaceId" value={workspaceId} />
                                    <input type="hidden" name="spendId" value={spend.id} />
                                    <button type="submit" className="fin-action-btn" style={{ color: "var(--warning)" }}>{t("btnEscalate")}</button>
                                  </form>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {activeTab === "accounts" && (
        <section style={{ marginTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h2 className="nr-section-header" style={{ margin: 0 }}>{t("ledgerAccounts")}</h2>
            {!isDemo && (
              <details className="fin-inline-create" style={{ position: "relative" }}>
                <summary className="button button-primary" style={{ cursor: "pointer", listStyle: "none" }}>{t("btnAddAccount")}</summary>
                <div className="fin-dropdown" style={{ right: 0, minWidth: "320px", marginTop: "8px" }}>
                  <form action={createLedgerAccountAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <label>
                      {t("colAccountName")}
                      <input name="name" required />
                    </label>
                    <div className="actions-inline">
                      <label style={{ flex: 1 }}>
                        {t("formCurrency")}
                        <input name="currency" defaultValue="USD" required />
                      </label>
                      <label style={{ flex: 1 }}>
                        {t("formType")}
                        <input name="type" defaultValue="MANUAL" />
                      </label>
                    </div>
                    <label>
                      {t("formOpeningBalance")}
                      <input name="balanceCents" type="number" defaultValue={0} />
                    </label>
                    <button type="submit">{t("btnCreateAccount")}</button>
                  </form>
                </div>
              </details>
            )}
          </div>
          {ledgerAccounts.length === 0 && <p className="muted">{t("noAccounts")}</p>}
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>{t("colAccountName")}</th>
                  <th>{t("formType")}</th>
                  <th>{t("formCurrency")}</th>
                  <th style={{ textAlign: "right" }}>{t("colBalance")}</th>
                  {!isDemo && <th>{t("colActions")}</th>}
                </tr>
              </thead>
              <tbody>
                {ledgerAccounts.map((account) => (
                  <tr key={account.id}>
                    <td><strong>{account.name}</strong></td>
                    <td>{account.type}</td>
                    <td>{account.currency}</td>
                    <td style={{ textAlign: "right", fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace" }}>
                      {fmt(account.balanceCents, account.currency)}
                    </td>
                    {!isDemo && (
                      <td>
                        <details style={{ display: "inline-block" }}>
                          <summary className="fin-action-btn" style={{ cursor: "pointer" }}>{t("btnEdit")}</summary>
                          <div className="fin-dropdown">
                            <form action={updateLedgerAccountAction} className="fin-dropdown-form">
                              <input type="hidden" name="workspaceId" value={workspaceId} />
                              <input type="hidden" name="accountId" value={account.id} />
                              <input name="name" defaultValue={account.name} placeholder={t("formAccountName")} />
                              <input name="currency" defaultValue={account.currency} placeholder={t("formCurrency")} />
                              <input name="type" defaultValue={account.type} placeholder={t("formType")} />
                              <button type="submit" className="fin-action-btn">{t("btnSave")}</button>
                            </form>
                            <form action={archiveLedgerAccountAction} className="fin-dropdown-form">
                              <input type="hidden" name="workspaceId" value={workspaceId} />
                              <input type="hidden" name="accountId" value={account.id} />
                              <button type="submit" className="fin-action-btn" style={{ color: "#842029" }}>{t("btnArchiveAccount")}</button>
                            </form>
                          </div>
                        </details>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
