# Corgtex — Anthropic Connector Directory Submission

**Form:** https://clau.de/mcp-directory-submission  
**Status:** Ready to submit — fill in the 🔲 items below, then open the form.

---

## 🔲 Before You Submit (fill these in first)

| Item | Value needed |
|------|--------------|
| Test account email | A real Corgtex user on `app.corgtex.com` (e.g. your own) |
| Test account password | The password for that account |
| Test workspace slug/URL | The workspace the reviewer should land in |
| GA date | Date the production server became public (or "live now") |
| Your contact email | Submission contact — `hello@corgtex.com` or your personal |

---

## Section 1 — Server Basics

**Server name:** `Corgtex`

**Server URL (MCP endpoint):**
```
https://app.corgtex.com/mcp
```

**Short tagline (≤80 chars):**
```
Governance OS — proposals, actions, goals, brain, meetings, and spend
```

**Full description:**
```
Corgtex is an organizational operating system built for governed AI workforces.
The MCP connector gives Claude full read/write access to your Corgtex workspace:
governance proposals, action items, tensions, goals, meeting notes, the Brain
knowledge base, members, circles, spend requests, and planning cycles.

Typical prompts: "What proposals need my vote this week?", "Create an action for
Jan to review the Q3 budget", "Summarize last Tuesday's meeting", "What does our
constitution say about salary decisions?", "Show me all open tensions in the
Product circle."

Works with Claude.ai (web and desktop) and Claude Code. Authentication uses
OAuth 2.0 with PKCE and Dynamic Client Registration — no API key setup required.
```

**Use cases / category:** Productivity · Project management · Governance · Knowledge management

---

## Section 2 — Connection Details

**Authentication type:** OAuth 2.0 (Authorization Code + PKCE, Dynamic Client Registration)

**Transport protocol:** Streamable HTTP (MCP 2025-03 spec)

**Redirect URIs to allowlist:**
```
https://claude.ai/api/mcp/auth_callback
https://claude.com/api/mcp/auth_callback
```
*(These are automatically handled — DCR lets Claude self-register its callback URIs.)*

**Read capabilities:** Yes (search, list, get tools for all resource types)

**Write capabilities:** Yes (create, update, archive, submit tools for all resource types)

**Requires authentication:** Yes — workspace OAuth login

**Connection requirements:** User must have a Corgtex account and belong to a workspace.

---

## Section 3 — Data & Compliance

**Privacy policy URL:** `https://corgtex.com/privacy`

**Terms of service URL:** `https://corgtex.com/terms`

**Data handling:**
Corgtex reads and writes data in the user's own Corgtex workspace. No data is
shared with third parties. Credentials are encrypted at rest. All API calls are
scoped to the authenticated workspace via OAuth — no cross-workspace access.
User consent is collected at authorization time via the OAuth approval screen.

**Third-party connections:** None (all data lives in Corgtex's own database)

**Conversation data retention:** Not retained beyond the functional MCP request/response

---

## Section 4 — Tools & Resources

**Total tool count:** 70

### Tools by category

#### Core / Search
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `chat` | write | Send a message to the Corgtex AI governance assistant |
| `search_knowledge` | read | Semantic search over the Brain (policies, meetings, proposals) |
| `search` | read | Search for ChatGPT/Claude/Cursor — returns fetchable result IDs |
| `fetch` | read | Fetch the full knowledge chunk for a search result ID |
| `get_workspace_info` | read | Workspace name, description, and aggregate counts |
| `daily_overview` | read | One-call digest: open actions, proposals, tensions, meetings, spend |
| `set_feature_flag` | write | Enable/disable a workspace feature flag (Admin) |
| `list_feature_flags` | read | List workspace feature flags with defaults and current values |

#### Proposals (governance)
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_proposals` | read | List governance proposals (filter by status/circle) |
| `get_proposal` | read | Full record for a single proposal |
| `create_proposal` | write | Create a DRAFT proposal |
| `update_proposal` | write | Edit a draft proposal's title, body, or owning circle |
| `submit_proposal` | write | Open a DRAFT proposal to the workspace (starts approval flow) |
| `publish_proposal` | write | Legacy: open draft proposal (prefer submit_proposal) |
| `resolve_proposal` | write | Manually resolve an OPEN proposal with outcome + note |
| `return_proposal_to_draft` | write | Return OPEN proposal to DRAFT |
| `archive_proposal` | write | Archive a resolved/draft proposal |

#### Actions (todos)
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_actions` | read | List action items in the workspace |
| `create_action` | write | Create a DRAFT action item |
| `update_action` | write | Update action content or workflow status |
| `complete_action` | write | Mark an action as COMPLETED |
| `return_action_to_draft` | write | Return OPEN/IN_PROGRESS action to DRAFT |
| `delete_action` | write | Delete an action item |

#### Tensions (issues)
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_tensions` | read | List tensions raised in the workspace |
| `create_tension` | write | Create a DRAFT tension |
| `update_tension` | write | Update tension content or resolution fields |
| `upvote_tension` | write | Upvote a tension (user-only) |
| `return_tension_to_draft` | write | Return OPEN tension to DRAFT |
| `delete_tension` | write | Delete a tension |

#### Goals
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_goals` | read | List goals (filter by cadence, level, status) |
| `get_goal` | read | Full record for a single goal with key results |
| `create_goal` | write | Create a workspace goal with optional key results |
| `update_goal` | write | Update goal status, progress, dates, content |
| `return_goal_to_draft` | write | Return active goal to DRAFT |
| `delete_goal` | write | Delete (archive) a goal |

#### Meetings & Knowledge
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_meetings` | read | List meetings with summaries |
| `get_meeting` | read | Full meeting record with transcript, summary, linked proposals |
| `upload_meeting` | write | Upload meeting minutes / transcript — indexed into Brain |
| `delete_meeting` | write | Archive a meeting and its transcript |
| `list_articles` | read | List Brain articles (policies, runbooks, decisions…) |
| `get_article` | read | Full Markdown body and metadata for a Brain article |
| `create_article` | write | Create a Brain article (Markdown body, wikilinks auto-linked) |
| `update_article` | write | Update a DRAFT Brain article |
| `publish_article` | write | Open a draft Brain article to the workspace |
| `return_article_to_draft` | write | Return a public article to DRAFT |
| `delete_article` | write | Archive a Brain article |
| `create_discussion_thread` | write | Open a discussion thread on a Brain article |
| `add_discussion_comment` | write | Add a comment to a Brain discussion thread |
| `resolve_discussion` | write | Mark a Brain discussion thread as RESOLVED |
| `upload_document_text` | write | Upload text data into workspace documents |
| `get_constitution` | read | The current workspace constitution Markdown |
| `list_policies` | read | Active policy corpus — every accepted proposal that became policy |
| `list_approval_policies` | read | Approval policies that govern how proposals get accepted/rejected |
| `search_knowledge` | read | *(listed above)* |

#### Members & Org Structure
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_members` | read | List workspace members with roles |
| `create_member` | write | Onboard a new member (Admin) |
| `update_member` | write | Update member email, role, name, status (Admin) |
| `deactivate_member` | write | Deactivate a member for offboarding (Admin) |
| `resend_member_access_link` | write | Resend setup/reset access link (Admin) |
| `list_circles` | read | List circles (teams / domains) with roles |
| `list_tool_links` | read | List shared workspace tool links (no credentials) |
| `upsert_tool_link` | write | Create or update a shared workspace tool link |
| `reveal_tool_link_credential` | read | Reveal encrypted credential for a tool link (audited) |
| `archive_tool_link` | write | Archive a shared tool link |

#### Cycles / Planning
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_cycles` | read | List all planning cycles |
| `get_cycle` | read | Full cycle record with updates and allocations |
| `create_cycle` | write | Create a new planning cycle |
| `update_cycle` | write | Update cycle metadata or status |
| `list_cycle_updates` | read | List member updates for a cycle |
| `list_allocations` | read | List point allocations within a cycle |

#### Finance
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_spends` | read | List spend requests in the workspace |
| `create_spend_draft` | write | Create a DRAFT spend request |
| `create_spend` | write | Create and open a spend request in one call (legacy) |
| `update_spend` | write | Update a DRAFT spend request |
| `submit_spend` | write | Open a DRAFT spend for approval |
| `return_spend_to_draft` | write | Return an OPEN spend to DRAFT |
| `archive_spend` | write | Archive a spend request |
| `list_ledger_accounts` | read | List ledger accounts (checking, savings, credit…) |
| `list_ledger_transactions` | read | List ledger entries, optionally scoped to one account |
| `archive_ledger_account` | write | Archive a ledger account |

#### Archive & Admin
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_archived_artifacts` | read | List archived artifacts for recovery and audit |
| `archive_artifact` | write | Archive any supported workspace artifact |
| `restore_artifact` | write | Restore an archived artifact to active views |
| `purge_artifact` | write | Permanently purge an eligible archived artifact (restricted) |

#### Support / Diagnostics (support-only scope)
| Tool name | Read/Write | Description |
|-----------|-----------|-------------|
| `list_integrations` | read | List installed communication integrations |
| `list_data_sources` | read | List external data feeds and sync state |
| `sync_data_source` | write | Trigger a manual sync for a data feed |
| `list_agent_runs` | read | List recent agent runs and tool calls |
| `list_runtime_jobs` | read | List recent workflow jobs |
| `list_failed_jobs` | read | List failed workflow jobs |
| `retry_failed_job` | write | Replay a failed workflow job |
| `discard_failed_job` | write | Mark a failed job as cancelled |
| `record_support_audit` | write | Record a Corgtex Support audit event (support creds only) |

---

## Section 5 — Documentation & Support

**Documentation URL:** `https://app.corgtex.com/install`

**Claude installer guide:** `https://app.corgtex.com/install/claude`

**Claude Code installer guide:** `https://app.corgtex.com/install/claude-code`

**Support channel:** `hello@corgtex.com`

**GitHub repo:** `https://github.com/Corgtexdotcom/corgtex` (private — contact hello@corgtex.com for access)

---

## Section 6 — Branding

**Logo (SVG):**
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="#1a1a1a"/>
  <text x="16" y="22" text-anchor="middle" font-family="Georgia, serif" font-size="20" font-weight="700" fill="#faf9f6">C</text>
  <rect x="6" y="26" width="20" height="2" rx="1" fill="#c41e1e"/>
</svg>
```

**Logo URL (if form accepts URL):** `https://corgtex.com/icon.svg`

**Primary color:** `#1a1a1a` (near-black background), `#c41e1e` (accent red)

---

## Section 7 — Test Account

🔲 **Provide to Anthropic's reviewers:**
- Login URL: `https://app.corgtex.com/login`
- Email: _[your test account email]_
- Password: _[your test account password]_
- Workspace to use: _[workspace name or URL slug]_
- Setup notes: "After login, you will be prompted to authorize the connector. Accept all default scopes."

*Tip: Create a dedicated reviewer account (e.g. `reviewer@corgtex.com`) with a non-sensitive workspace pre-populated with sample data.*

---

## Section 8 — Production Readiness

- [x] Server is live at `https://app.corgtex.com/mcp`
- [x] All tools tested via MCP Inspector and custom connector in Claude.ai
- [x] OAuth flow tested end-to-end (DCR → PKCE → consent → token)
- [x] Tool annotations present (`readOnlyHint`, `destructiveHint`, `title` on all 70 tools)
- [x] Privacy policy live at `https://corgtex.com/privacy`
- [x] Terms of service live at `https://corgtex.com/terms`
- [x] Public documentation live at `https://app.corgtex.com/install`
- [x] Origin-header validation in place
- [x] `.well-known/oauth-protected-resource` and `.well-known/oauth-authorization-server` configured
- [ ] Test account provided to reviewers (see Section 7)

---

## Submission Link

Open the form and paste from the sections above:  
**https://clau.de/mcp-directory-submission**

After submitting, watch `hello@corgtex.com` for a confirmation and then a review decision (typically ~2 weeks).  
For escalations: `mcp-review@anthropic.com`
