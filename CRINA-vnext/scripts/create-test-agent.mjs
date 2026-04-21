import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

async function main() {
  const ws = await prisma.workspace.findUnique({ where: { slug: "corgtex" } });
  if (!ws) throw new Error("Corgtex workspace not found. Did you seed it?");
  
  const email = "agent-e2e@corgtex.com";
  const password = "corgtex-test-agent-pw";
  
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        displayName: "Agent Browser Test",
        passwordHash: hashPassword(password)
      }
    });
  } else {
    user = await prisma.user.update({
      where: { email },
      data: { passwordHash: hashPassword(password) }
    });
  }
  
  await prisma.member.upsert({
    where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } },
    update: { role: "ADMIN", isActive: true },
    create: { workspaceId: ws.id, userId: user.id, role: "ADMIN", isActive: true }
  });
  
  console.log(`Successfully created/updated agent test user: ${email} / ${password}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
