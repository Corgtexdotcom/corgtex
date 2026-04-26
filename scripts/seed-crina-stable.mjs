import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, scryptSync } from "node:crypto";

const prisma = new PrismaClient();

const VALID_MEMBER_ROLES = new Set(["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"]);

const WORKSPACE_SLUG = process.env.WORKSPACE_SLUG?.trim() || "crina";
const WORKSPACE_NAME = process.env.WORKSPACE_NAME?.trim() || "CRINA";
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

function boolFromEnv(name, defaultValue = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  return value === "1" || value === "true" || value === "yes";
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

function randomOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!value) throw new Error("User email is required.");
  return value;
}

function normalizeRole(role) {
  const value = String(role || "CONTRIBUTOR").trim().toUpperCase();
  if (!VALID_MEMBER_ROLES.has(value)) {
    throw new Error(`Invalid CRINA member role '${role}'. Use one of: ${[...VALID_MEMBER_ROLES].join(", ")}.`);
  }
  return value;
}

function parseCrinaUsers() {
  const json = process.env.CRINA_USERS_JSON?.trim();
  if (json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error("CRINA_USERS_JSON must be an array.");
    }
    return parsed.map((user) => ({
      email: normalizeEmail(user.email),
      displayName: user.displayName ? String(user.displayName).trim() : null,
      role: normalizeRole(user.role),
    }));
  }

  const csv = process.env.CRINA_USERS_CSV?.trim();
  if (!csv) return [];

  return csv
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [displayName, email, role] = line.split(",").map((part) => part.trim());
      return {
        email: normalizeEmail(email),
        displayName: displayName || null,
        role: normalizeRole(role),
      };
    });
}

async function sendInvitationEmail(email, displayName, setupUrl) {
  if (!boolFromEnv("CRINA_SEND_INVITES")) return;

  const apiKey = required("RESEND_API_KEY");
  const from = required("EMAIL_FROM");
  const replyTo = process.env.EMAIL_REPLY_TO?.trim();

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "You have been invited to the CRINA workspace",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2>Join the CRINA workspace</h2>
          <p>Hi ${displayName || "there"},</p>
          <p>You have been invited to set up your CRINA workspace account.</p>
          <p><a href="${setupUrl}" style="background-color: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">Set up your account</a></p>
        </div>
      `,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Invitation email failed for ${email}: ${response.status} ${body}`);
  }
}

async function upsertApprovalPolicy(workspaceId, subjectType, mode) {
  await prisma.approvalPolicy.upsert({
    where: {
      workspaceId_subjectType: {
        workspaceId,
        subjectType,
      },
    },
    update: {
      mode,
      quorumPercent: 0,
      minApproverCount: 1,
      decisionWindowHours: 72,
      requireProposalLink: false,
    },
    create: {
      workspaceId,
      subjectType,
      mode,
      quorumPercent: 0,
      minApproverCount: 1,
      decisionWindowHours: 72,
      requireProposalLink: false,
    },
  });
}

async function ensureCircle(workspaceId, name, purposeMd, sortOrder) {
  const existing = await prisma.circle.findFirst({ where: { workspaceId, name } });
  if (existing) {
    return prisma.circle.update({
      where: { id: existing.id },
      data: { purposeMd, sortOrder, archivedAt: null },
    });
  }

  return prisma.circle.create({
    data: {
      workspaceId,
      name,
      purposeMd,
      sortOrder,
    },
  });
}

async function ensureRole(circleId, name, purposeMd, accountabilities, sortOrder) {
  const existing = await prisma.role.findFirst({ where: { circleId, name } });
  if (existing) {
    return prisma.role.update({
      where: { id: existing.id },
      data: { purposeMd, accountabilities, sortOrder, archivedAt: null },
    });
  }

  return prisma.role.create({
    data: {
      circleId,
      name,
      purposeMd,
      accountabilities,
      artifacts: [],
      sortOrder,
    },
  });
}

async function ensureAction(workspaceId, authorUserId, circleId, assigneeMemberId) {
  const existing = await prisma.action.findFirst({
    where: { workspaceId, title: "Confirm CRINA launch user list" },
  });
  if (existing) return existing;

  return prisma.action.create({
    data: {
      workspaceId,
      circleId,
      authorUserId,
      assigneeMemberId,
      title: "Confirm CRINA launch user list",
      bodyMd: "Confirm the final client user list, workspace roles, and invitation delivery before handover.",
      status: "OPEN",
      publishedAt: new Date(),
    },
  });
}

async function ensureTension(workspaceId, authorUserId, circleId, assigneeMemberId) {
  const existing = await prisma.tension.findFirst({
    where: { workspaceId, title: "Clarify first client handover priorities" },
  });
  if (existing) return existing;

  return prisma.tension.create({
    data: {
      workspaceId,
      circleId,
      authorUserId,
      assigneeMemberId,
      title: "Clarify first client handover priorities",
      bodyMd: "Use this starter tension to agree what CRINA should validate first during the stable handover period.",
      status: "OPEN",
      priority: 2,
      urgency: 1,
      importance: 2,
      publishedAt: new Date(),
    },
  });
}

async function ensureMeeting(workspaceId, participantIds) {
  const existing = await prisma.meeting.findFirst({
    where: { workspaceId, title: "CRINA Stable Handover Kickoff" },
  });
  if (existing) return existing;

  return prisma.meeting.create({
    data: {
      workspaceId,
      title: "CRINA Stable Handover Kickoff",
      source: "crina-stable-seed",
      recordedAt: new Date("2026-04-26T16:00:00.000Z"),
      participantIds,
      summaryMd: [
        "## CRINA Stable Handover Kickoff",
        "",
        "- Confirmed the stable workspace surface for client handover.",
        "- Relationships, Agent Governance, and OS Metrics remain postponed.",
        "- Initial validation focuses on tensions, meetings, proposals, circles, finance, audit, members, and settings.",
      ].join("\n"),
      transcript: "Seeded handover meeting placeholder. Replace with approved CRINA meeting notes after client review.",
    },
  });
}

async function ensureProposal(workspaceId, authorUserId, circleId, meetingId) {
  const existing = await prisma.proposal.findFirst({
    where: { workspaceId, title: "Adopt CRINA stable workspace scope" },
  });
  if (existing) return existing;

  return prisma.proposal.create({
    data: {
      workspaceId,
      authorUserId,
      circleId,
      meetingId,
      title: "Adopt CRINA stable workspace scope",
      summary: "Use the stable handover scope as the client-facing CRINA workspace baseline.",
      bodyMd: [
        "## Proposal",
        "",
        "For the initial CRINA client handover, expose the stable workspace modules only: operations, tensions, actions, meetings, proposals, circles, finance, audit, members, and settings.",
        "",
        "Relationships, Agent Governance, and OS Metrics stay disabled until they complete a separate readiness review.",
      ].join("\n"),
      status: "OPEN",
      publishedAt: new Date(),
    },
  });
}

async function ensureFinance(workspaceId, requesterUserId) {
  let account = await prisma.ledgerAccount.findFirst({
    where: { workspaceId, name: "CRINA Operating" },
  });
  if (!account) {
    account = await prisma.ledgerAccount.create({
      data: {
        workspaceId,
        name: "CRINA Operating",
        type: "MANUAL",
        currency: "USD",
        balanceCents: 0,
      },
    });
  }

  const existingSpend = await prisma.spendRequest.findFirst({
    where: { workspaceId, description: "Initial CRINA workspace readiness review" },
  });
  if (!existingSpend) {
    await prisma.spendRequest.create({
      data: {
        workspaceId,
        requesterUserId,
        ledgerAccountId: account.id,
        amountCents: 50000,
        currency: "USD",
        category: "Operations",
        description: "Initial CRINA workspace readiness review",
        vendor: "Corgtex",
        status: "OPEN",
        spentAt: new Date("2026-04-26T16:00:00.000Z"),
      },
    });
  }

  return account;
}

async function ensureBrainGuide(workspaceId) {
  const bodyMd = [
    "# CRINA Workspace Handover Guide",
    "",
    "This workspace is configured for the stable CRINA client handover.",
    "",
    "## Included areas",
    "",
    "- Operations: tensions, actions, and meetings",
    "- Governance: proposals and circles",
    "- Finance: spend requests and ledger accounts",
    "- Audit trail",
    "- Members and settings",
    "",
    "## Postponed areas",
    "",
    "- Relationships / CRM pipeline",
    "- Agent Governance",
    "- OS Metrics / OS Matrix",
  ].join("\n");

  const article = await prisma.brainArticle.upsert({
    where: {
      workspaceId_slug: {
        workspaceId,
        slug: "crina-workspace-handover-guide",
      },
    },
    update: {
      title: "CRINA Workspace Handover Guide",
      type: "RUNBOOK",
      authority: "AUTHORITATIVE",
      bodyMd,
      isPrivate: false,
    },
    create: {
      workspaceId,
      slug: "crina-workspace-handover-guide",
      title: "CRINA Workspace Handover Guide",
      type: "RUNBOOK",
      authority: "AUTHORITATIVE",
      bodyMd,
      isPrivate: false,
      publishedAt: new Date(),
      sourceIds: [],
    },
  });

  const existingVersion = await prisma.brainArticleVersion.findFirst({
    where: { articleId: article.id, version: 1 },
  });
  if (!existingVersion) {
    await prisma.brainArticleVersion.create({
      data: {
        articleId: article.id,
        version: 1,
        bodyMd,
        changeSummary: "Initial CRINA stable handover guide",
      },
    });
  }
}

async function main() {
  const resetPasswords = boolFromEnv("SEED_RESET_PASSWORDS");
  const seedSampleData = boolFromEnv("CRINA_SEED_SAMPLE_DATA", true);
  const printInviteLinks = boolFromEnv("CRINA_PRINT_INVITE_LINKS");
  const clientUsers = parseCrinaUsers();

  const workspace = await prisma.workspace.upsert({
    where: { slug: WORKSPACE_SLUG },
    update: {
      name: WORKSPACE_NAME,
      description: "Stable client workspace for CRINA.",
    },
    create: {
      slug: WORKSPACE_SLUG,
      name: WORKSPACE_NAME,
      description: "Stable client workspace for CRINA.",
    },
  });

  const adminEmail = normalizeEmail(process.env.CRINA_BOOTSTRAP_ADMIN_EMAIL || process.env.ADMIN_EMAIL);
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  if ((!existingAdmin || resetPasswords) && !adminPassword) {
    throw new Error("ADMIN_PASSWORD is required when creating or resetting the CRINA bootstrap admin.");
  }

  const adminUser = existingAdmin
    ? await prisma.user.update({
        where: { email: adminEmail },
        data: {
          displayName: process.env.ADMIN_DISPLAY_NAME?.trim() || existingAdmin.displayName || "CRINA Admin",
          globalRole: "OPERATOR",
          ...(resetPasswords ? { passwordHash: hashPassword(adminPassword) } : {}),
        },
      })
    : await prisma.user.create({
        data: {
          email: adminEmail,
          displayName: process.env.ADMIN_DISPLAY_NAME?.trim() || "CRINA Admin",
          passwordHash: hashPassword(adminPassword),
          globalRole: "OPERATOR",
        },
      });

  const adminMember = await prisma.member.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: adminUser.id } },
    update: { role: "ADMIN", isActive: true },
    create: { workspaceId: workspace.id, userId: adminUser.id, role: "ADMIN", isActive: true },
  });

  const featureFlagValues = [
    ["RELATIONSHIPS", false],
    ["AGENT_GOVERNANCE", false],
    ["OS_METRICS", false],
    ["MULTILINGUAL", boolFromEnv("CRINA_ENABLE_MULTILINGUAL")],
  ];
  for (const [flag, enabled] of featureFlagValues) {
    await prisma.workspaceFeatureFlag.upsert({
      where: { workspaceId_flag: { workspaceId: workspace.id, flag } },
      update: { enabled, config: null },
      create: { workspaceId: workspace.id, flag, enabled, config: null },
    });
  }

  await upsertApprovalPolicy(workspace.id, "PROPOSAL", "CONSENT");
  await upsertApprovalPolicy(workspace.id, "SPEND", "SINGLE");

  const clientMembers = [];
  const inviteResults = [];
  for (const clientUser of clientUsers) {
    const existingUser = await prisma.user.findUnique({ where: { email: clientUser.email } });
    const user = existingUser
      ? await prisma.user.update({
          where: { email: clientUser.email },
          data: {
            ...(clientUser.displayName !== null ? { displayName: clientUser.displayName } : {}),
          },
        })
      : await prisma.user.create({
          data: {
            email: clientUser.email,
            displayName: clientUser.displayName,
            passwordHash: hashPassword(randomOpaqueToken()),
          },
        });

    const member = await prisma.member.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      update: { role: clientUser.role, isActive: true },
      create: { workspaceId: workspace.id, userId: user.id, role: clientUser.role, isActive: true },
    });

    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    const token = randomOpaqueToken();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const setupUrl = `${APP_URL}/setup-account/${token}`;
    await sendInvitationEmail(user.email, user.displayName, setupUrl);
    inviteResults.push({ email: user.email, role: member.role, setupUrl });
    clientMembers.push({ user, member });
  }

  const general = await ensureCircle(workspace.id, "General", "Shared CRINA workspace coordination and cross-circle decisions.", 0);
  const operations = await ensureCircle(workspace.id, "Operations", "Coordinate tensions, actions, meetings, and operating rhythm.", 10);
  const governance = await ensureCircle(workspace.id, "Governance", "Maintain proposals, circles, roles, and consent-based decisions.", 20);
  const finance = await ensureCircle(workspace.id, "Finance", "Track spend requests, ledger accounts, approvals, and reconciliation.", 30);

  const roles = {
    owner: await ensureRole(general.id, "Workspace Owner", "Owns stable client handover readiness.", ["Maintain workspace access", "Confirm handover readiness"], 0),
    facilitator: await ensureRole(operations.id, "Meeting Facilitator", "Maintains meeting and tension processing rhythm.", ["Prepare meetings", "Process tensions", "Track follow-ups"], 0),
    governance: await ensureRole(governance.id, "Governance Steward", "Maintains proposals and circle structure.", ["Review proposals", "Maintain circles and roles"], 0),
    finance: await ensureRole(finance.id, "Finance Steward", "Maintains finance workflow readiness.", ["Review spend requests", "Maintain ledger hygiene"], 0),
  };

  const allMembers = [{ user: adminUser, member: adminMember }, ...clientMembers];
  for (const { member } of allMembers) {
    const roleIds = [];
    if (member.role === "ADMIN") roleIds.push(roles.owner.id, roles.facilitator.id, roles.governance.id, roles.finance.id);
    if (member.role === "FACILITATOR") roleIds.push(roles.facilitator.id, roles.governance.id);
    if (member.role === "FINANCE_STEWARD") roleIds.push(roles.finance.id);
    for (const roleId of roleIds) {
      await prisma.roleAssignment.upsert({
        where: { roleId_memberId: { roleId, memberId: member.id } },
        update: {},
        create: { roleId, memberId: member.id },
      });
    }
  }

  if (seedSampleData) {
    const participantIds = allMembers.map(({ user }) => user.id);
    const meeting = await ensureMeeting(workspace.id, participantIds);
    await ensureTension(workspace.id, adminUser.id, operations.id, adminMember.id);
    await ensureAction(workspace.id, adminUser.id, operations.id, adminMember.id);
    await ensureProposal(workspace.id, adminUser.id, governance.id, meeting.id);
    await ensureFinance(workspace.id, adminUser.id);
    await ensureBrainGuide(workspace.id);
  }

  const existingAudit = await prisma.auditLog.findFirst({
    where: { workspaceId: workspace.id, action: "crina.stable_seeded", entityId: workspace.id },
  });
  if (!existingAudit) {
    await prisma.auditLog.create({
      data: {
        workspaceId: workspace.id,
        actorUserId: adminUser.id,
        action: "crina.stable_seeded",
        entityType: "Workspace",
        entityId: workspace.id,
        meta: {
          disabledFeatures: ["RELATIONSHIPS", "AGENT_GOVERNANCE", "OS_METRICS"],
          sampleDataSeeded: seedSampleData,
        },
      },
    });
  }

  console.log(`Seeded CRINA stable workspace '${workspace.slug}' (${workspace.id}).`);
  console.log(`Client users processed: ${inviteResults.length}.`);
  if (boolFromEnv("CRINA_SEND_INVITES")) {
    console.log("Invitation emails sent.");
  } else if (inviteResults.length > 0) {
    console.log("Invitation emails were not sent. Set CRINA_SEND_INVITES=true after email configuration is verified.");
  }
  if (printInviteLinks) {
    for (const invite of inviteResults) {
      console.log(`${invite.email} (${invite.role}): ${invite.setupUrl}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
