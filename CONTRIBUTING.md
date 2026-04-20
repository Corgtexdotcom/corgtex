# Contributing to Corgtex

We love your input! We want to make contributing to this project as easy and transparent as possible, whether it's:
- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features

## Development Setup

### Prerequisites

- Node.js 22 (we recommend using `nvm` or `asdf`)
- Docker Desktop or equivalent (for PostgreSQL)

### 1. Clone & Install

```bash
git clone https://github.com/corgtex/corgtex.git
cd corgtex
npm install
```

### 2. Start PostgreSQL

We use Docker to run a local Postgres instance required for Prisma.

```bash
docker compose -f docker-compose.selfhost.yml up postgres -d
```

### 3. Setup Database Schema and Seeds

```bash
cp .env.example .env

# Generate Prisma client
npm run prisma:generate

# Apply migrations
npm run prisma:migrate:deploy

# Run initial seed
npm run prisma:seed
```

### 4. Start Development Server

```bash
npm run dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## Testing

Before submitting a Pull Request, ensure all tests and type checks pass:

```bash
npm run check        # Run ESLint, TypeScript check, and Prisma schema validation
npm run test:unit    # Run unit tests via Vitest
```

## Pull Request Process

1. Fork the repo and create your branch from `main`.
2. Ensure your PR is focused on a single change.
3. If you're adding a new feature, make sure to add tests.
4. Ensure the test suite passes (`npm run check` and `npm run test:unit`).
5. Open your PR and include a detailed description of the changes.

## Code Style

- We use TypeScript (strict mode) everywhere.
- 2-space indentation, double quotes, semicolons.
- Use `@/*` imports for App modules and `@corgtex/*` for shared package modules.
- Read `AGENTS.md` for more architecture references.

## Architecture Guidelines

- **Next.js App Router:** Ensure database-dependent pages are strictly dynamic (`export const dynamic = "force-dynamic"`). 
- **Packages:** Keep business logic inside `packages/domain/`.
- **Worker:** Background job dispatch goes into `apps/worker/` running through our outbox mechanism.

Thank you for contributing!
