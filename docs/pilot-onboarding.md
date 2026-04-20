# Corgtex Pilot Onboarding Runbook

This guide details the onboarding workflow for a new pilot client ($10M+ revenue, mixed industries) using our Phase 2 capabilities (Regex Classification + BYO-DB Ingestion).

## 1. Initial Provisioning
1. **Workspace Creation**: The Corgtex admin creates a root workspace for the pilot client.
2. **SSO Configuration**: An admin navigates to Workspace Settings -> General -> SSO and registers the client's OIDC provider.
3. **Agent Cost Budget**: Go to Workspace Settings -> Agents. Set the monthly budget to $250/m and enable the 80% threshold alert to manage pilot pilot exposure limit securely.

## 2. Ingesting Flat File Data
If the client relies on SaaS platforms that don't have direct database access, ask them to export CSV files.
1. Use the **Upload Data** component (currently accessible via the root Knowledge page or via Slack drop).
2. The pipeline automatically applies our Zero-LLM PII Regex Classifier.
3. **Verification**: After uploading, test search in the agent to ensure chunks labeled `PII` or `CONFIDENTIAL` are appropriately returned only to authorized workflows and never exposed in standard responses.

## 3. Ingesting Internal DBs (Postgres)
For internal tools (e.g. Metabase replicas, customer records) backed by Postgres:
1. Provide the pilot explicit instructions on generating a **Read-Only** Postgres user pointing to a securely accessible IP or Bastion host.
   - Example command to run on their system:
     ```sql
     CREATE USER corgtex_readonly WITH PASSWORD 'SecurePass!';
     GRANT CONNECT ON DATABASE production TO corgtex_readonly;
     GRANT USAGE ON SCHEMA public TO corgtex_readonly;
     GRANT SELECT ON ALL TABLES IN SCHEMA public TO corgtex_readonly;
     ```
2. Navigate to **Workspace Settings -> Data Sources**.
3. Create a **New Database**, using the `postgres://` connection string provided by the DevOps team.
4. Set the desired sync cadence (e.g. 60 minutes). By default, we select standard public tables.
5. Click **Sync Now** to start ingestion.
6. Verify the UI dashboard reflects chunk counts incrementing securely under `byodb:XXX` references.

## 4. End-to-End Testing & Handoff
1. Go to the general AI chat and verify the ingested knowledge.
2. Example check: "What are the latest records from the synced public.customers table?"
3. Confirm that the data respects RBAC constraints and the established budgets track token throughput accurately.
4. Distribute initial login links to the main pilot points-of-contact.
