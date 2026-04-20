import { listSpends, listLedgerAccounts } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  createSpendAction,
  submitSpendAction,
  markSpendPaidAction,
  linkSpendLedgerAccountAction,
  uploadSpendStatementAction,
  updateSpendReconciliationAction,
  createLedgerAccountAction,
  updateLedgerAccountAction,
  addSpendCommentAction,
  resolveSpendObjectionAction,
  escalateSpendToProposalAction,
} from "../actions";
import Link from "next/link";
import { prisma } from "@corgtex/shared";

export const dynamic = "force-dynamic";


function fmt(cents: number, currency: string = "USD") {
  const abs = Math.abs(cents / 100);
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export default async function FinancePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  await requirePageActor();
  const resolvedSearch = searchParams ? await searchParams : {};
  const activeTab = typeof resolvedSearch.tab === "string" ? resolvedSearch.tab : "spends";
  const statusFilter = typeof resolvedSearch.status === "string" ? resolvedSearch.status : "ALL";

  const [spendsResult, ledgerAccountsResult, currentWorkspace] = await Promise.all([
    listSpends(workspaceId, { take: 200 }),
    listLedgerAccounts(workspaceId, { take: 50 }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";
  const spends = spendsResult.items;
  const ledgerAccounts = ledgerAccountsResult.items;

  // Totals
  const totalSubmitted = spends.filter((s) => s.status === "SUBMITTED").reduce((a, s) => a + s.amountCents, 0);
  const totalApproved = spends.filter((s) => s.status === "APPROVED").reduce((a, s) => a + s.amountCents, 0);
  const totalPaid = spends.filter((s) => s.status === "PAID").reduce((a, s) => a + s.amountCents, 0);
  const totalAll = spends.reduce((a, s) => a + s.amountCents, 0);

  // Status counts
  const statusCounts = {
    ALL: spends.length,
    DRAFT: spends.filter((s) => s.status === "DRAFT").length,
    SUBMITTED: spends.filter((s) => s.status === "SUBMITTED").length,
    OBJECTED: spends.filter((s) => s.status === "OBJECTED").length,
    APPROVED: spends.filter((s) => s.status === "APPROVED").length,
    PAID: spends.filter((s) => s.status === "PAID").length,
    REJECTED: spends.filter((s) => s.status === "REJECTED").length,
  };

  const filteredSpends = statusFilter === "ALL"
    ? spends
    : spends.filter((s) => s.status === statusFilter);

  const tabs = [
    { key: "spends", label: "Spend Requests" },
    { key: "accounts", label: "Ledger Accounts" },
  ];

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Finance</h1>
        <div className="nr-masthead-meta">
          <span>Spend tracking, ledger accounts, and reconciliation.</span>
        </div>
      </header>

      {/* Summary Bar */}
      <div className="nr-stat-bar">
        <span className="nr-stat"><strong>{fmt(totalAll)}</strong> total</span>
        <span className="nr-stat-sep">·</span>
        <span className="nr-stat" style={{ color: "var(--warning)" }}><strong>{fmt(totalSubmitted)}</strong> pending</span>
        <span className="nr-stat-sep">·</span>
        <span className="nr-stat"><strong>{fmt(totalApproved)}</strong> approved</span>
        <span className="nr-stat-sep">·</span>
        <span className="nr-stat" style={{ color: "var(--success)" }}><strong>{fmt(totalPaid)}</strong> paid</span>
        <span className="nr-stat-sep">·</span>
        <span className="nr-stat"><strong>{ledgerAccounts.length}</strong> accounts</span>
      </div>

      {/* Tab Bar */}
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

      {/* Account Chips */}
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

      {/* Spend Requests Tab */}
      {activeTab === "spends" && (
        <section style={{ marginTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h2 className="nr-section-header" style={{ margin: 0 }}>Spend Requests</h2>
            {!isDemo && (
              <details className="fin-inline-create" style={{ position: "relative" }}>
                <summary className="button button-primary" style={{ cursor: "pointer", listStyle: "none" }}>+ Add Spend Request</summary>
                <div className="fin-dropdown" style={{ right: 0, minWidth: "320px", marginTop: "8px" }}>
                  <form action={createSpendAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <label>
                      Amount ($)
                      <input name="amount" type="number" step="0.01" min="0.01" required />
                    </label>
                    <div className="actions-inline">
                      <label style={{ flex: 1 }}>
                        Currency
                        <input name="currency" defaultValue="USD" required />
                      </label>
                      <label style={{ flex: 1 }}>
                        Category
                        <input name="category" required />
                      </label>
                    </div>
                    <label>
                      Description
                      <textarea name="description" required />
                    </label>
                    <label>
                      Vendor
                      <input name="vendor" />
                    </label>
                    <label>
                      Ledger Account
                      <select name="ledgerAccountId" defaultValue="">
                        <option value="">Unassigned</option>
                        {ledgerAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.name} ({account.currency})</option>
                        ))}
                      </select>
                    </label>
                    <button type="submit">Create Spend Draft</button>
                  </form>
                </div>
              </details>
            )}
          </div>
          {/* Status filter */}
          <div className="nr-filter-bar">
            {(["ALL", "DRAFT", "SUBMITTED", "OBJECTED", "APPROVED", "PAID", "REJECTED"] as const).map((s) => (
              <Link
                key={s}
                href={`?tab=spends&status=${s}`}
                className={`nr-filter-item ${statusFilter === s ? "nr-filter-active" : ""}`}
              >
                {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()} ({statusCounts[s]})
              </Link>
            ))}
          </div>

          {filteredSpends.length === 0 && <p className="muted" style={{ fontSize: "0.85rem", marginTop: 16 }}>No spend requests match this filter.</p>}

          {filteredSpends.length > 0 && (
            <div className="nr-table-wrap">
              <table className="nr-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Category</th>
                    <th>Description</th>
                    <th>Vendor</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th>Status</th>
                    <th>Account</th>
                    <th>Reconciled</th>
                    {!isDemo && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredSpends.map((spend) => (
                    <tr key={spend.id}>
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
                        <span className={`fin-status-badge fin-status-${spend.status.toLowerCase()}`}>
                          {spend.status}
                        </span>
                      </td>
                      <td className="fin-td-account">
                        {spend.ledgerAccount ? spend.ledgerAccount.name : "—"}
                      </td>
                      <td>
                        <span className={`fin-recon-badge fin-recon-${spend.reconciliationStatus.toLowerCase()}`}>
                          {spend.reconciliationStatus === "PENDING" ? "—" : spend.reconciliationStatus}
                        </span>
                      </td>
                      {!isDemo && (
                        <td className="fin-td-actions">
                          {spend.status === "DRAFT" && (
                            <form action={submitSpendAction} style={{ display: "inline" }}>
                              <input type="hidden" name="workspaceId" value={workspaceId} />
                              <input type="hidden" name="spendId" value={spend.id} />
                              <button type="submit" className="fin-action-btn">Submit</button>
                            </form>
                          )}
                          <details style={{ display: "inline-block" }}>
                            <summary className="fin-action-btn" style={{ cursor: "pointer" }}>⋯</summary>
                            <div className="fin-dropdown" style={{ width: 320, padding: "16px" }}>
                              {spend.comments && spend.comments.length > 0 && (
                                <div className="fin-thread">
                                  {spend.comments.map((comment: any) => (
                                    <div key={comment.id} className={`fin-comment ${comment.isObjection ? 'fin-comment-objection' : ''} ${comment.resolvedAt ? 'fin-comment-resolved' : ''}`}>
                                      <div className="fin-comment-meta">
                                        <span>{comment.author.displayName || comment.author.email}</span>
                                        <span>{new Date(comment.createdAt).toLocaleDateString()}</span>
                                      </div>
                                      {comment.isObjection && !comment.resolvedAt && (
                                        <div style={{ marginBottom: "8px" }}><span className="fin-objection-badge">OBJECTION</span></div>
                                      )}
                                      <div className="nr-markdown" style={{ fontSize: "0.85rem", margin: 0 }}>
                                        {comment.bodyMd}
                                      </div>
                                      {comment.isObjection && !comment.resolvedAt && (
                                        <form action={resolveSpendObjectionAction} style={{ marginTop: "8px" }}>
                                          <input type="hidden" name="workspaceId" value={workspaceId} />
                                          <input type="hidden" name="spendId" value={spend.id} />
                                          <input type="hidden" name="commentId" value={comment.id} />
                                          <button type="submit" className="button button-small" style={{ fontSize: "0.75rem", padding: "2px 8px" }}>Resolve</button>
                                        </form>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {(spend.status === "SUBMITTED" || spend.status === "OBJECTED") && (
                                <form action={addSpendCommentAction} className="stack nr-form-section" style={{ marginTop: 0, paddingBottom: 16, borderBottom: "1px solid var(--line)" }}>
                                  <input type="hidden" name="workspaceId" value={workspaceId} />
                                  <input type="hidden" name="spendId" value={spend.id} />
                                  <textarea name="bodyMd" required placeholder="Add a comment or objection..." style={{ minHeight: "60px", fontSize: "0.85rem", padding: "8px", width: "100%", borderRadius: "4px", border: "1px solid var(--line)" }} />
                                  <div style={{ display: "flex", gap: "8px" }}>
                                    <button type="submit" className="button" style={{ flex: 1, padding: "4px 8px", fontSize: "0.8rem" }}>Comment</button>
                                    <button type="submit" name="isObjection" value="true" className="button" style={{ flex: 1, padding: "4px 8px", fontSize: "0.8rem", color: "var(--danger)", borderColor: "var(--danger)" }}>Raise Objection</button>
                                  </div>
                                </form>
                              )}

                              {spend.status === "OBJECTED" && (
                                <form action={escalateSpendToProposalAction} className="fin-dropdown-form" style={{ marginTop: "16px" }}>
                                  <input type="hidden" name="workspaceId" value={workspaceId} />
                                  <input type="hidden" name="spendId" value={spend.id} />
                                  <button type="submit" className="fin-action-btn" style={{ color: "var(--warning)" }}>Escalate to Proposal</button>
                                </form>
                              )}

                              {(spend.status === "APPROVED" || (spend.status === "SUBMITTED" && (!spend.comments || spend.comments.filter((c: any) => c.isObjection && !c.resolvedAt).length === 0))) && (
                                <form action={markSpendPaidAction} className="fin-dropdown-form" style={{ marginTop: "16px" }}>
                                  <input type="hidden" name="workspaceId" value={workspaceId} />
                                  <input type="hidden" name="spendId" value={spend.id} />
                                  <input
                                    name="receiptUrl"
                                    placeholder="Receipt URL"
                                    defaultValue={spend.receiptUrl ?? ""}
                                    required
                                  />
                                  <button type="submit" className="fin-action-btn fin-action-pay">Mark paid</button>
                                </form>
                              )}
                              <form action={linkSpendLedgerAccountAction} className="fin-dropdown-form">
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="spendId" value={spend.id} />
                                <select name="ledgerAccountId" defaultValue={spend.ledgerAccountId ?? ""}>
                                  <option value="">Unlinked</option>
                                  {ledgerAccounts.map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                  ))}
                                </select>
                                <button type="submit" className="fin-action-btn">Link</button>
                              </form>
                              {spend.status === "PAID" && (
                                <>
                                  <form action={uploadSpendStatementAction} className="fin-dropdown-form">
                                    <input type="hidden" name="workspaceId" value={workspaceId} />
                                    <input type="hidden" name="spendId" value={spend.id} />
                                    <input
                                      name="storageKey"
                                      placeholder="Statement storage key"
                                      defaultValue={spend.statementStorageKey ?? ""}
                                      required
                                    />
                                    <input name="fileName" placeholder="File name" defaultValue={spend.statementFileName ?? ""} />
                                    <input name="mimeType" placeholder="MIME type" defaultValue={spend.statementMimeType ?? ""} />
                                    <button type="submit" className="fin-action-btn">Attach statement</button>
                                  </form>
                                  <form action={updateSpendReconciliationAction} className="fin-dropdown-form">
                                    <input type="hidden" name="workspaceId" value={workspaceId} />
                                    <input type="hidden" name="spendId" value={spend.id} />
                                    <select name="status" defaultValue={spend.reconciliationStatus}>
                                      <option value="PENDING">Pending</option>
                                      <option value="STATEMENT_ATTACHED">Statement</option>
                                      <option value="RECONCILED">Reconciled</option>
                                    </select>
                                    <input name="note" placeholder="Note" defaultValue={spend.reconciliationNote ?? ""} />
                                    <button type="submit" className="fin-action-btn">Save</button>
                                  </form>
                                </>
                              )}
                            </div>
                          </details>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Ledger Accounts Tab */}
      {activeTab === "accounts" && (
        <section style={{ marginTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <h2 className="nr-section-header" style={{ margin: 0 }}>Ledger Accounts</h2>
            {!isDemo && (
              <details className="fin-inline-create" style={{ position: "relative" }}>
                <summary className="button button-primary" style={{ cursor: "pointer", listStyle: "none" }}>+ Add Ledger Account</summary>
                <div className="fin-dropdown" style={{ right: 0, minWidth: "320px", marginTop: "8px" }}>
                  <form action={createLedgerAccountAction} className="stack nr-form-section" style={{ marginTop: 0 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <label>
                      Account Name
                      <input name="name" required />
                    </label>
                    <div className="actions-inline">
                      <label style={{ flex: 1 }}>
                        Currency
                        <input name="currency" defaultValue="USD" required />
                      </label>
                      <label style={{ flex: 1 }}>
                        Type
                        <input name="type" defaultValue="MANUAL" />
                      </label>
                    </div>
                    <label>
                      Opening Balance (cents)
                      <input name="balanceCents" type="number" defaultValue={0} />
                    </label>
                    <button type="submit">Create Account</button>
                  </form>
                </div>
              </details>
            )}
          </div>
          {ledgerAccounts.length === 0 && <p className="muted">No ledger accounts defined yet.</p>}
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Account Name</th>
                  <th>Type</th>
                  <th>Currency</th>
                  <th style={{ textAlign: "right" }}>Balance</th>
                  {!isDemo && <th>Actions</th>}
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
                          <summary className="fin-action-btn" style={{ cursor: "pointer" }}>Edit</summary>
                          <div className="fin-dropdown">
                            <form action={updateLedgerAccountAction} className="fin-dropdown-form">
                              <input type="hidden" name="workspaceId" value={workspaceId} />
                              <input type="hidden" name="accountId" value={account.id} />
                              <input name="name" defaultValue={account.name} placeholder="Name" />
                              <input name="currency" defaultValue={account.currency} placeholder="Currency" />
                              <input name="type" defaultValue={account.type} placeholder="Type" />
                              <button type="submit" className="fin-action-btn">Save</button>
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
