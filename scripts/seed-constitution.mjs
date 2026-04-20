import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const initialConstitutionBody = `# Constitution

## Mission
To help create ownership transitions that preserve stewardship, protect livelihoods, and keep long-term value anchored in the communities businesses serve, ensuring the best businesses outlast their founders without losing their character.

## Vision
To bring enterprise-grade self-management and long-term employee ownership to manufacturing companies in North America, creating an economy of Employee Owned & Controlled (EOC) companies.

## Purpose
To preserve value, protect people, and transition businesses without handing them to extractive buyers, ensuring long-term independence and legacy protection.

---

## 10 Organizational Principles

### 1. Employee Ownership (ESOP)
All members hold a stake in the organization, creating aligned incentives and shared prosperity.

### 2. Self-Management
Authority is distributed to roles, not individuals. Members manage their own roles autonomously within their defined domains.

### 3. Durable Transition
We prioritize long-term stability and legacy preservation over short-term extraction.

### 4. Distributed Authority
Decision-making power is pushed to where the work happens, eliminating bottlenecks and empowering action.

### 5. Radical Transparency
All organizational data, tensions, and decisions are open by default. Information parity is essential for effective self-management.

### 6. Role-Based Governance
Work is organized around distinct roles with clear purposes and accountabilities, decoupled from the individuals who fill them.

### 7. Aligned Incentives
Compensation, equity, and recognition are designed to reward collective success and long-term value creation.

### 8. Legacy Preservation
We protect the character and independence of our businesses from extractive forces.

### 9. Community Anchoring
We recognize that businesses are rooted in their communities and strive to sustain local economies and livelihoods.

### 10. Long-term Independence
Our structures and policies are designed to ensure the organization remains self-governing and resilient against external control.`

async function main() {
  const workspace = await prisma.workspace.findFirst({
    orderBy: { createdAt: 'asc' }
  })
  if (!workspace) {
    console.error("No workspace found. Cannot seed constitution.")
    process.exit(1)
  }

  const existing = await prisma.constitution.findFirst({
    where: { workspaceId: workspace.id, version: 1 }
  })

  if (existing) {
    console.log("Constitution version 1 already exists. Skipping.")
    return
  }

  const constitution = await prisma.constitution.create({
    data: {
      workspaceId: workspace.id,
      version: 1,
      bodyMd: initialConstitutionBody,
      diffSummary: "Initial constitution seeded from website context.",
      modelUsed: "manual-seed",
      triggerType: "MANUAL",
      triggerRef: "seed-script"
    }
  })

  console.log(`Successfully seeded initial constitution (v${constitution.version}) for workspace ${workspace.id}.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
