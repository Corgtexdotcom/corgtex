import { PrismaClient } from "@prisma/client";
import { seedAgentIdentities } from "@corgtex/domain";

const prisma = new PrismaClient();

async function main() {
  const workspaceIdArg = process.argv[2];

  if (workspaceIdArg) {
    console.log(`Seeding agent identities for workspace: ${workspaceIdArg}`);
    await seedAgentIdentities(workspaceIdArg);
  } else {
    console.log("No workspaceId provided, seeding for all workspaces...");
    const workspaces = await prisma.workspace.findMany({ select: { id: true } });
    for (const ws of workspaces) {
      console.log(`Seeding agent identities for workspace: ${ws.id}`);
      await seedAgentIdentities(ws.id);
    }
  }

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
