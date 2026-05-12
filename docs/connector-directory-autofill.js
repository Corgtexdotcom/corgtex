// ============================================================
// CORGTEX MCP DIRECTORY SUBMISSION — CHROME CONSOLE AUTO-FILL
//
// 1. Open https://clau.de/mcp-directory-submission in Chrome
// 2. Open DevTools (Cmd+Option+J)
// 3. Paste this entire script and press Enter
// 4. It fills every text field it recognises — radio/checkbox
//    fields are logged so you can click them manually
// ============================================================

const ANSWERS = {
  // ---- Server basics ----
  "server name":            "Corgtex",
  "server url":             "https://app.corgtex.com/mcp",
  "mcp server url":         "https://app.corgtex.com/mcp",
  "connector url":          "https://app.corgtex.com/mcp",
  "endpoint":               "https://app.corgtex.com/mcp",
  "tagline":                "Governance OS — proposals, actions, goals, brain, meetings, and spend",
  "short description":      "Governance OS — proposals, actions, goals, brain, meetings, and spend",

  "description":
`Corgtex is an organizational operating system for governed AI workforces. The MCP connector gives Claude full read/write access to your Corgtex workspace: governance proposals, action items, tensions, goals, meeting notes, the Brain knowledge base, members, circles, spend requests, and planning cycles.

Typical prompts: "What proposals need my vote this week?", "Create an action for Jan to review the Q3 budget", "Summarize last Tuesday's meeting", "What does our constitution say about salary decisions?"

Authentication uses OAuth 2.0 with PKCE and Dynamic Client Registration — no API key setup required. Works with Claude.ai (web and desktop) and Claude Code.`,

  "use case":
`- Governance: draft, discuss, and vote on proposals; track the active policy corpus
- Operations: manage action items, tensions, goals, and planning cycles
- Knowledge: search the Brain, read meeting transcripts, browse articles and runbooks
- Finance: create and submit spend requests, view ledger accounts`,

  "category":               "Productivity",
  "website":                "https://corgtex.com",
  "homepage":               "https://corgtex.com",

  // ---- Connection details ----
  "authentication":         "OAuth 2.0 — Authorization Code with PKCE (S256) + Dynamic Client Registration (RFC 7591). No API key setup required; Claude self-registers via DCR.",
  "auth type":              "OAuth 2.0 (Authorization Code + PKCE + DCR)",
  "auth":                   "OAuth 2.0 (Authorization Code + PKCE + DCR)",
  "transport":              "Streamable HTTP (MCP spec 2025-03-26)",
  "protocol":               "Streamable HTTP",

  "redirect":
`https://claude.ai/api/mcp/auth_callback
https://claude.com/api/mcp/auth_callback`,

  "callback":
`https://claude.ai/api/mcp/auth_callback
https://claude.com/api/mcp/auth_callback`,

  "allowed link":           "https://app.corgtex.com",
  "connection requirement": "User must have a Corgtex account and belong to at least one workspace. Sign-in is handled via the OAuth consent screen during first connection.",

  // ---- Data & compliance ----
  "privacy":                "https://corgtex.com/privacy",
  "terms":                  "https://corgtex.com/terms",

  "data":
`Corgtex reads and writes data only within the authenticated user's own Corgtex workspace. No cross-workspace access is possible. No data is shared with third parties. User credentials are encrypted at rest. Consent is collected at OAuth authorization time.`,

  "third":                  "None — all data remains within Corgtex's own database.",
  "conversation":           "Not retained beyond the functional MCP request/response cycle.",

  // ---- Tools ----
  "tool count":             "70",
  "number of tools":        "70",
  "how many tools":         "70",

  "tools":
`chat, search_knowledge, search, fetch, get_workspace_info, daily_overview,
list_proposals, get_proposal, create_proposal, update_proposal, submit_proposal, resolve_proposal, return_proposal_to_draft, archive_proposal,
list_actions, create_action, update_action, complete_action, return_action_to_draft, delete_action,
list_tensions, create_tension, update_tension, upvote_tension, return_tension_to_draft, delete_tension,
list_goals, get_goal, create_goal, update_goal, return_goal_to_draft, delete_goal,
list_meetings, get_meeting, upload_meeting, delete_meeting,
list_articles, get_article, create_article, update_article, publish_article, return_article_to_draft, delete_article, create_discussion_thread, add_discussion_comment, resolve_discussion, upload_document_text, get_constitution, list_policies, list_approval_policies,
list_members, create_member, update_member, deactivate_member, resend_member_access_link, list_circles, list_tool_links, upsert_tool_link, reveal_tool_link_credential, archive_tool_link,
list_cycles, get_cycle, create_cycle, update_cycle, list_cycle_updates, list_allocations,
list_spends, create_spend_draft, create_spend, update_spend, submit_spend, return_spend_to_draft, archive_spend, list_ledger_accounts, list_ledger_transactions, archive_ledger_account,
list_archived_artifacts, archive_artifact, restore_artifact, purge_artifact`,

  // ---- Documentation & support ----
  "documentation":          "https://app.corgtex.com/install",
  "docs url":               "https://app.corgtex.com/install",
  "help":                   "https://app.corgtex.com/install",
  "support":                "hello@corgtex.com",
  "contact":                "hello@corgtex.com",
  "email":                  "hello@corgtex.com",

  // ---- Branding ----
  "logo":                   "https://corgtex.com/icon.svg",
  "icon":                   "https://corgtex.com/icon.svg",
  "server logo":            "https://corgtex.com/icon.svg",

  // ---- Test account ----
  "test account":           "Email: puncar@corgtex.com  |  Login: https://app.corgtex.com/login  |  Workspace: J&J Demo",
  "test":                   "puncar@corgtex.com",
  "test email":             "puncar@corgtex.com",
  "test password":          "(enter manually — your Corgtex password)",
  "test workspace":         "J&J Demo — https://app.corgtex.com/workspaces/18582aea-9f64-49ba-a3da-8ac8ef03ddd8",
  "setup":                  "After login, accept the OAuth consent screen (all default scopes). The workspace J&J Demo has sample proposals, actions, goals, meetings, and Brain articles.",
  "login":                  "https://app.corgtex.com/login",

  // ---- Availability ----
  "general availability":   "2025",
  "ga date":                "2025",
  "launch":                 "2025",
  "platform":               "Claude.ai (web and desktop), Claude Code",
  "tested":                 "Claude.ai web, Claude.ai desktop, Claude Code (CLI)",
};

function matchAnswer(questionText) {
  const q = questionText.toLowerCase();
  for (const [key, val] of Object.entries(ANSWERS)) {
    if (q.includes(key)) return val;
  }
  return null;
}

let filled = 0;
let skipped = [];

// ---- Fill text inputs and textareas ----
document.querySelectorAll('input[type="text"], textarea').forEach(el => {
  // Walk up to find the question container
  let container = el.closest('[data-item-id]')
    || el.closest('.freebirdFormviewerViewItemsItemItem')
    || el.closest('[role="listitem"]')
    || el.parentElement?.parentElement;

  const rawText = container?.innerText || el.getAttribute('aria-label') || el.placeholder || '';
  const questionLine = rawText.split('\n').find(l => l.trim().length > 3) || rawText;

  const answer = matchAnswer(questionLine);
  if (answer) {
    el.focus();
    // Use native input value setter so React/Angular onChange fires
    const nativeInput = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    );
    nativeInput?.set?.call(el, answer);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    filled++;
    console.log(`%c✓ "${questionLine.substring(0,55)}"`, 'color:green', `→ "${answer.substring(0,60)}${answer.length>60?'…':''}"`);
  } else {
    skipped.push(questionLine.substring(0,60));
  }
});

// ---- Log radio/checkbox questions so you can click them ----
console.log('\n%cRadio / Checkbox fields (click manually):', 'font-weight:bold;color:orange');
const seen = new Set();
document.querySelectorAll('[role="radio"], [role="checkbox"]').forEach(el => {
  const container = el.closest('[role="listitem"]') || el.parentElement;
  const q = container?.querySelector('[role="heading"]')?.innerText
         || container?.innerText?.split('\n')[0]
         || '';
  const opt = el.getAttribute('aria-label') || el.closest('label')?.innerText || '';
  if (!seen.has(q)) { console.log(`  Q: "${q.substring(0,60)}"`); seen.add(q); }
  console.log(`     • option: "${opt}"`);
});

console.log(`\n%c✅ Auto-filled ${filled} text fields.`, 'color:green;font-weight:bold');
if (skipped.length) {
  console.log('%cFields with no match (fill manually):', 'color:#888');
  skipped.forEach(s => s.trim() && console.log(`  - "${s}"`));
}
