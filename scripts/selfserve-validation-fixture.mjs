import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { SELF_SERVE_WORKSPACE_TOUR_KEY, SELF_SERVE_WORKSPACE_TOUR_VERSION } from "../packages/domain/src/onboarding.ts";

// Only the disposable internal-network runner invokes this script. This is
// deliberately not a mode of the production provisioning helper.
const database = new URL(process.env.DATABASE_URL || "http://invalid");
if (database.hostname !== "fixture-pg" || database.pathname !== "/selfserve_validation_synthetic"
  || process.env.SELFSERVE_ISOLATED_FIXTURE !== "true") throw new Error("ISOLATED_FIXTURE_REQUIRED");
const prisma = new PrismaClient();
try {
  if (await prisma.workspace.count() || await prisma.user.count()) throw new Error("ISOLATED_FIXTURE_NOT_EMPTY");
  const salt = randomBytes(16).toString("hex");
  const password = process.env.ISOLATED_VALIDATION_PASSWORD;
  if (!password) throw new Error("ISOLATED_PASSWORD_REQUIRED");
  const user = await prisma.user.create({ data: { email: "validation@synthetic.invalid", displayName: "Synthetic validation owner",
    globalRole: "USER", passwordHash: `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}` } });
  for (const slug of ["corgtex-validation", "jnj-demo"]) {
    const workspace = await prisma.workspace.create({ data: { slug, name: `Synthetic ${slug}`,
      members: { create: { userId: user.id, kind: "HUMAN", role: "ADMIN", isActive: true } } } });
    await prisma.userWorkspaceOnboardingState.create({ data: { userId: user.id, workspaceId: workspace.id,
      tourKey: SELF_SERVE_WORKSPACE_TOUR_KEY, tourVersion: SELF_SERVE_WORKSPACE_TOUR_VERSION, completedAt: new Date() } });
  }
} finally { await prisma.$disconnect(); }
