import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { parseArgs } from "util";

const prisma = new PrismaClient();

// Utility for hashing passwords during seed
async function hashPass(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

// Ensure unique content chunks
function hashContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function main() {
  const args = parseArgs({
    options: {
      "workspace-slug": { type: "string" },
    },
    strict: false,
  });

  const workspaceSlug = args.values["workspace-slug"] || process.env.WORKSPACE_SLUG;
  if (!workspaceSlug) {
    console.error("[SEED] Error: WORKSPACE_SLUG is required to run seed-example.mjs");
    process.exit(1);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { urlSlug: workspaceSlug },
  });

  if (!workspace) {
    console.error(`[SEED] Error: Workspace '${workspaceSlug}' not found.`);
    process.exit(1);
  }

  console.log(`\n[SEED] 🌱 Running Example Seed (Acme Corp) for ${workspace.name}...`);

  // --- 1. Team Members ---
  const usersToCreate = [
    { email: "alice.manager@example.com", name: "Alice Manager", password: "password123", role: "ADMIN" },
    { email: "bob.engineer@example.com", name: "Bob Engineer", password: "password123", role: "MEMBER" },
    { email: "charlie.designer@example.com", name: "Charlie Designer", password: "password123", role: "MEMBER" },
  ];

  const members = {};
  for (const u of usersToCreate) {
    const hashedParams = await hashPass(u.password);
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name },
      create: {
        email: u.email,
        name: u.name,
        passwordHash: hashedParams,
      },
    });

    members[u.name.split(" ")[0].toLowerCase()] = await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      update: { role: u.role },
      create: {
        workspaceId: workspace.id,
        userId: user.id,
        role: u.role,
        email: u.email,
      },
    });
  }

  const anchorMember = members.alice; // Primary actor

  // --- 2. Organization Circles & Roles ---
  const engineeringCircle = await prisma.circle.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "Engineering" } },
    update: { description: "Builds and maintains Acme's products." },
    create: {
      workspaceId: workspace.id,
      name: "Engineering",
      description: "Builds and maintains Acme's products.",
      createdById: anchorMember.id,
    },
  });

  const productCircle = await prisma.circle.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "Product" } },
    update: { description: "Designs and shapes the product vision." },
    create: {
      workspaceId: workspace.id,
      name: "Product",
      description: "Designs and shapes the product vision.",
      createdById: anchorMember.id,
    },
  });

  // Assign roles
  await prisma.role.upsert({
    where: { circleId_name: { circleId: engineeringCircle.id, name: "Lead Engineer" } },
    update: { description: "Technical leader.", memberId: members.bob.id },
    create: {
      workspaceId: workspace.id,
      circleId: engineeringCircle.id,
      name: "Lead Engineer",
      description: "Technical leader.",
      memberId: members.bob.id,
      createdById: anchorMember.id,
    },
  });

  // --- 3. Knowledge Base (Brain Articles) ---
  const articles = [
    {
      title: "Welcome to Acme Corp",
      content: "Acme Corp is a leading fictional provider of anvils and roadrunner-catching equipment. We empower coyotes everywhere.",
      authorId: anchorMember.id,
    },
    {
      title: "Engineering Principles",
      content: "1. Always build redundant systems.\n2. Explosives must be handled with care.\n3. Ship fast, but safely.",
      authorId: members.bob.id,
    },
    {
      title: "Product Design Language",
      content: "Our aesthetics rely on bold red and metallic gray. Our products must be immediately recognizable from a cliffside.",
      authorId: members.charlie.id,
    }
  ];

  for (const doc of articles) {
    const article = await prisma.article.upsert({
      where: { workspaceId_title: { workspaceId: workspace.id, title: doc.title } },
      update: { content: doc.content },
      create: {
        workspaceId: workspace.id,
        title: doc.title,
        content: doc.content,
        authorId: doc.authorId,
        publishedAt: new Date(),
        status: "PUBLISHED",
      },
    });

    // Chunking for search/agent
    await prisma.knowledgeChunk.upsert({
      where: { workspaceId_hash: { workspaceId: workspace.id, hash: hashContent(article.content) } },
      update: {},
      create: {
        workspaceId: workspace.id,
        content: article.content,
        hash: hashContent(article.content),
        sourceType: "ARTICLE",
        sourceId: article.id,
        metadata: { title: article.title, author: doc.authorId },
      },
    });
  }

  console.log(`[SEED] ✅ Sample 'Acme Corp' data seeded for ${workspace.name}.\n`);
}

main()
  .catch((e) => {
    console.error("[SEED] Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
