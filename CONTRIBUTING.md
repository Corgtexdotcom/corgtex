# Contributing to Corgtex

Corgtex is developed by an autonomous three-agent pipeline (Planner →
Executor → Reviewer). The canonical specification for how work moves
through that pipeline lives in
[`docs/contributing/agent-pipeline.mdx`](docs/contributing/agent-pipeline.mdx).
Per-role rules that each AI agent's harness loads automatically live in
[`AGENTS.md`](AGENTS.md).

If you are a human contributing manually, follow the same branching and
PR process documented below — you'll just be playing all three roles
yourself.

## Development Setup

### Prerequisites

- Node.js 22 (we recommend `nvm` or `asdf`)
- Docker Desktop or equivalent (for PostgreSQL)

### 1. Clone & Install

```bash
git clone https://github.com/corgtex/corgtex.git
cd corgtex
npm install
```

### 2. Start PostgreSQL

```bash
docker compose -f docker-compose.selfhost.yml up postgres -d
```

### 3. Setup Database Schema and Seeds

```bash
cp .env.example .env

npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:seed
```

### 4. Start Development Server

```bash
npm run dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## Testing

The canonical commands and testing philosophy are in
[`AGENTS.md`](AGENTS.md#build-test-check). Before opening a PR, at
minimum run:

```bash
npm run check        # lint + typecheck + prisma validate
npm run test:unit    # Vitest unit suite
```

## Pull Request Process

Every PR must originate from a plan file at `docs/plans/<branch>.md`
(see [`docs/plans/_TEMPLATE.md`](docs/plans/_TEMPLATE.md)). The Reviewer
rejects PRs without a plan, with out-of-scope file changes, or with
missing acceptance criteria.

The full workflow is documented in
[`docs/contributing/agent-pipeline.mdx`](docs/contributing/agent-pipeline.mdx)
and summarized per role in [`AGENTS.md`](AGENTS.md). Do not duplicate
those rules here.

## Code Style

- TypeScript (strict mode) everywhere.
- 2-space indentation, double quotes, semicolons.
- `@/*` imports for `apps/web` modules; `@corgtex/*` for shared packages.

Full conventions in [`AGENTS.md`](AGENTS.md#code-style).

Thank you for contributing!
