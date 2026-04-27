import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, scryptSync } from "node:crypto";

const VALID_MEMBER_ROLES = new Set(["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"]);

export function boolFromEnv(name, defaultValue = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  return value === "1" || value === "true" || value === "yes";
}

function boolFromAnyEnv(names, defaultValue = false) {
  for (const name of names) {
    if (process.env[name]?.trim()) return boolFromEnv(name, defaultValue);
  }
  return defaultValue;
}

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function requiredFromEnv(names) {
  const value = firstEnv(names);
  if (!value) {
    throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
  }
  return value;
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

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!value) throw new Error("User email is required.");
  return value;
}

function normalizeRole(role) {
  const value = String(role || "CONTRIBUTOR").trim().toUpperCase();
  if (!VALID_MEMBER_ROLES.has(value)) {
    throw new Error(`Invalid member role '${role}'. Use one of: ${[...VALID_MEMBER_ROLES].join(", ")}.`);
  }
  return value;
}

function slugify(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function parseClientUsers(envPrefix) {
  const json = firstEnv([`${envPrefix}_USERS_JSON`, "CLIENT_USERS_JSON"]);
  if (json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error(`${envPrefix}_USERS_JSON/CLIENT_USERS_JSON must be an array.`);
    }
    return parsed.map((user) => ({
      email: normalizeEmail(user.email),
      displayName: user.displayName ? String(user.displayName).trim() : null,
      role: normalizeRole(user.role),
    }));
  }

  const csv = firstEnv([`${envPrefix}_USERS_CSV`, "CLIENT_USERS_CSV"]);
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

async function sendInvitationEmail(config, email, displayName, setupUrl) {
  const envPrefix = config.envPrefix;
  if (!boolFromAnyEnv([`${envPrefix}_SEND_INVITES`, "CLIENT_SEND_INVITES"])) return;

  const apiKey = requiredFromEnv(["RESEND_API_KEY"]);
  const from = requiredFromEnv(["EMAIL_FROM"]);
  const replyTo = firstEnv(["EMAIL_REPLY_TO"]);
  const invite = config.invite;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: invite.subject,
      html: `
        <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px;">
          <h2>${invite.title}</h2>
          <p>${invite.greeting.replace("{name}", displayName || invite.fallbackName || "there")}</p>
          <p>${invite.body}</p>
          <p><a href="${setupUrl}" style="background-color: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">${invite.button}</a></p>
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

async function upsertApprovalPolicy(tx, workspaceId, subjectType, mode) {
  await tx.approvalPolicy.upsert({
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

async function ensureCircle(tx, workspaceId, circle) {
  const existing = await tx.circle.findFirst({ where: { workspaceId, name: circle.name } });
  if (existing) {
    return tx.circle.update({
      where: { id: existing.id },
      data: {
        purposeMd: circle.purposeMd ?? null,
        domainMd: circle.domainMd ?? null,
        maturityStage: circle.maturityStage ?? "GETTING_STARTED",
        sortOrder: circle.sortOrder ?? 0,
        archivedAt: null,
      },
    });
  }

  return tx.circle.create({
    data: {
      workspaceId,
      name: circle.name,
      purposeMd: circle.purposeMd ?? null,
      domainMd: circle.domainMd ?? null,
      maturityStage: circle.maturityStage ?? "GETTING_STARTED",
      sortOrder: circle.sortOrder ?? 0,
    },
  });
}

async function ensureRole(tx, circleId, role) {
  const existing = await tx.role.findFirst({ where: { circleId, name: role.name } });
  if (existing) {
    return tx.role.update({
      where: { id: existing.id },
      data: {
        purposeMd: role.purposeMd ?? null,
        accountabilities: role.accountabilities ?? [],
        sortOrder: role.sortOrder ?? 0,
        archivedAt: null,
      },
    });
  }

  return tx.role.create({
    data: {
      circleId,
      name: role.name,
      purposeMd: role.purposeMd ?? null,
      accountabilities: role.accountabilities ?? [],
      artifacts: role.artifacts ?? [],
      sortOrder: role.sortOrder ?? 0,
    },
  });
}

async function ensureBrainArticle(tx, workspaceId, article) {
  const slug = article.slug ?? slugify(article.title);
  const saved = await tx.brainArticle.upsert({
    where: {
      workspaceId_slug: {
        workspaceId,
        slug,
      },
    },
    update: {
      title: article.title,
      type: article.type,
      authority: article.authority,
      bodyMd: article.bodyMd,
      isPrivate: article.isPrivate ?? false,
      archivedAt: null,
    },
    create: {
      workspaceId,
      slug,
      title: article.title,
      type: article.type,
      authority: article.authority,
      bodyMd: article.bodyMd,
      isPrivate: article.isPrivate ?? false,
      publishedAt: new Date(),
      sourceIds: [],
    },
  });

  const existingVersion = await tx.brainArticleVersion.findFirst({
    where: { articleId: saved.id, version: 1 },
  });
  if (!existingVersion) {
    await tx.brainArticleVersion.create({
      data: {
        articleId: saved.id,
        version: 1,
        bodyMd: article.bodyMd,
        changeSummary: article.changeSummary ?? "Initial client seed article",
      },
    });
  }

  return saved;
}

async function ensureMeeting(tx, workspaceId, meeting, participantIds) {
  const existing = await tx.meeting.findFirst({ where: { workspaceId, title: meeting.title } });
  if (existing) {
    return tx.meeting.update({
      where: { id: existing.id },
      data: {
        source: meeting.source,
        recordedAt: new Date(meeting.recordedAt),
        participantIds,
        summaryMd: meeting.summaryMd,
        transcript: meeting.transcript,
        archivedAt: null,
      },
    });
  }

  return tx.meeting.create({
    data: {
      workspaceId,
      title: meeting.title,
      source: meeting.source,
      recordedAt: new Date(meeting.recordedAt),
      participantIds,
      summaryMd: meeting.summaryMd,
      transcript: meeting.transcript,
    },
  });
}

async function ensureTension(tx, workspaceId, userId, memberId, circleId, tension) {
  const existing = await tx.tension.findFirst({ where: { workspaceId, title: tension.title } });
  if (existing) {
    return tx.tension.update({
      where: { id: existing.id },
      data: {
        circleId,
        assigneeMemberId: memberId,
        bodyMd: tension.bodyMd,
        priority: tension.priority ?? 2,
        urgency: tension.urgency ?? 1,
        importance: tension.importance ?? 2,
        status: tension.status ?? "OPEN",
        publishedAt: existing.publishedAt ?? new Date(),
        archivedAt: null,
      },
    });
  }

  return tx.tension.create({
    data: {
      workspaceId,
      circleId,
      authorUserId: userId,
      assigneeMemberId: memberId,
      title: tension.title,
      bodyMd: tension.bodyMd,
      status: tension.status ?? "OPEN",
      priority: tension.priority ?? 2,
      urgency: tension.urgency ?? 1,
      importance: tension.importance ?? 2,
      publishedAt: new Date(),
    },
  });
}

async function ensureAction(tx, workspaceId, userId, memberId, circleId, action) {
  const existing = await tx.action.findFirst({ where: { workspaceId, title: action.title } });
  if (existing) {
    return tx.action.update({
      where: { id: existing.id },
      data: {
        circleId,
        assigneeMemberId: memberId,
        bodyMd: action.bodyMd,
        status: action.status ?? "OPEN",
        publishedAt: existing.publishedAt ?? new Date(),
        archivedAt: null,
      },
    });
  }

  return tx.action.create({
    data: {
      workspaceId,
      circleId,
      authorUserId: userId,
      assigneeMemberId: memberId,
      title: action.title,
      bodyMd: action.bodyMd,
      status: action.status ?? "OPEN",
      publishedAt: new Date(),
    },
  });
}

async function ensureProposal(tx, workspaceId, userId, circleId, meetingId, proposal) {
  const existing = await tx.proposal.findFirst({ where: { workspaceId, title: proposal.title } });
  if (existing) {
    return tx.proposal.update({
      where: { id: existing.id },
      data: {
        circleId,
        meetingId,
        summary: proposal.summary,
        bodyMd: proposal.bodyMd,
        status: proposal.status ?? "OPEN",
        publishedAt: existing.publishedAt ?? new Date(),
        archivedAt: null,
      },
    });
  }

  return tx.proposal.create({
    data: {
      workspaceId,
      authorUserId: userId,
      circleId,
      meetingId,
      title: proposal.title,
      summary: proposal.summary,
      bodyMd: proposal.bodyMd,
      status: proposal.status ?? "OPEN",
      publishedAt: new Date(),
    },
  });
}

async function ensureFinance(tx, workspaceId, requesterUserId, finance) {
  let account = await tx.ledgerAccount.findFirst({
    where: { workspaceId, name: finance.accountName },
  });
  if (account) {
    account = await tx.ledgerAccount.update({
      where: { id: account.id },
      data: {
        currency: finance.currency,
        type: "MANUAL",
        archivedAt: null,
      },
    });
  } else {
    account = await tx.ledgerAccount.create({
      data: {
        workspaceId,
        name: finance.accountName,
        type: "MANUAL",
        currency: finance.currency,
        balanceCents: finance.balanceCents ?? 0,
      },
    });
  }

  const spend = finance.starterSpend;
  if (spend) {
    const existingSpend = await tx.spendRequest.findFirst({
      where: { workspaceId, description: spend.description },
    });
    if (existingSpend) {
      await tx.spendRequest.update({
        where: { id: existingSpend.id },
        data: {
          ledgerAccountId: account.id,
          amountCents: spend.amountCents,
          currency: finance.currency,
          category: spend.category,
          vendor: spend.vendor,
          status: spend.status ?? "OPEN",
          spentAt: new Date(spend.spentAt),
          archivedAt: null,
        },
      });
    } else {
      await tx.spendRequest.create({
        data: {
          workspaceId,
          requesterUserId,
          ledgerAccountId: account.id,
          amountCents: spend.amountCents,
          currency: finance.currency,
          category: spend.category,
          description: spend.description,
          vendor: spend.vendor,
          status: spend.status ?? "OPEN",
          spentAt: new Date(spend.spentAt),
        },
      });
    }
  }

  return account;
}

async function ensureGoal(tx, workspaceId, goal, circleId, ownerMemberId, parentGoalId) {
  const existing = await tx.goal.findFirst({
    where: { workspaceId, title: goal.title },
  });
  const data = {
    parentGoalId: parentGoalId ?? null,
    circleId: circleId ?? null,
    ownerMemberId: ownerMemberId ?? null,
    descriptionMd: goal.descriptionMd ?? null,
    level: goal.level ?? "COMPANY",
    cadence: goal.cadence ?? "QUARTERLY",
    status: goal.status ?? "ACTIVE",
    progressPercent: goal.progressPercent ?? 0,
    targetDate: goal.targetDate ? new Date(goal.targetDate) : null,
    startDate: goal.startDate ? new Date(goal.startDate) : null,
    sortOrder: goal.sortOrder ?? 0,
    archivedAt: null,
  };

  const saved = existing
    ? await tx.goal.update({ where: { id: existing.id }, data })
    : await tx.goal.create({
        data: {
          workspaceId,
          title: goal.title,
          ...data,
        },
      });

  for (const [index, keyResult] of (goal.keyResults ?? []).entries()) {
    const existingKeyResult = await tx.keyResult.findFirst({
      where: { goalId: saved.id, title: keyResult.title },
    });
    const keyResultData = {
      targetValue: keyResult.targetValue ?? null,
      currentValue: keyResult.currentValue ?? 0,
      unit: keyResult.unit ?? null,
      progressPercent: keyResult.progressPercent ?? 0,
      sortOrder: keyResult.sortOrder ?? index,
    };
    if (existingKeyResult) {
      await tx.keyResult.update({ where: { id: existingKeyResult.id }, data: keyResultData });
    } else {
      await tx.keyResult.create({
        data: {
          goalId: saved.id,
          title: keyResult.title,
          ...keyResultData,
        },
      });
    }
  }

  return saved;
}

export async function seedStableClient(config) {
  const prisma = new PrismaClient();
  const envPrefix = config.envPrefix;
  const workspaceSlug = firstEnv([`${envPrefix}_WORKSPACE_SLUG`, "CLIENT_WORKSPACE_SLUG", "WORKSPACE_SLUG"]) ?? config.workspace.slug;
  const workspaceName = firstEnv([`${envPrefix}_WORKSPACE_NAME`, "CLIENT_WORKSPACE_NAME", "WORKSPACE_NAME"]) ?? config.workspace.name;
  const defaultLocale = firstEnv([`${envPrefix}_DEFAULT_LOCALE`, "CLIENT_DEFAULT_LOCALE", "NEXT_PUBLIC_DEFAULT_LOCALE"]) ?? config.defaultLocale ?? "en";
  const appUrl = (firstEnv(["NEXT_PUBLIC_APP_URL", "APP_URL"]) ?? "http://localhost:3000").replace(/\/$/, "");
  const resetPasswords = boolFromEnv("SEED_RESET_PASSWORDS");
  const printInviteLinks = boolFromAnyEnv([`${envPrefix}_PRINT_INVITE_LINKS`, "CLIENT_PRINT_INVITE_LINKS"]);
  const seedSampleData = boolFromAnyEnv([`${envPrefix}_SEED_SAMPLE_DATA`, "CLIENT_SEED_SAMPLE_DATA"], true);
  const clientUsers = parseClientUsers(envPrefix);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.upsert({
        where: { slug: workspaceSlug },
        update: {
          name: workspaceName,
          description: config.workspace.description,
        },
        create: {
          slug: workspaceSlug,
          name: workspaceName,
          description: config.workspace.description,
        },
      });

      const adminEmail = normalizeEmail(
        requiredFromEnv([`${envPrefix}_BOOTSTRAP_ADMIN_EMAIL`, "CLIENT_BOOTSTRAP_ADMIN_EMAIL", "ADMIN_EMAIL"]),
      );
      const existingAdmin = await tx.user.findUnique({ where: { email: adminEmail } });
      const adminPassword = process.env.ADMIN_PASSWORD?.trim();
      if ((!existingAdmin || resetPasswords) && !adminPassword) {
        throw new Error("ADMIN_PASSWORD is required when creating or resetting the bootstrap admin.");
      }

      const adminUser = existingAdmin
        ? await tx.user.update({
            where: { email: adminEmail },
            data: {
              displayName: firstEnv([`${envPrefix}_ADMIN_DISPLAY_NAME`, "CLIENT_ADMIN_DISPLAY_NAME", "ADMIN_DISPLAY_NAME"]) ?? existingAdmin.displayName ?? `${workspaceName} Admin`,
              globalRole: "OPERATOR",
              ...(resetPasswords ? { passwordHash: hashPassword(adminPassword) } : {}),
            },
          })
        : await tx.user.create({
            data: {
              email: adminEmail,
              displayName: firstEnv([`${envPrefix}_ADMIN_DISPLAY_NAME`, "CLIENT_ADMIN_DISPLAY_NAME", "ADMIN_DISPLAY_NAME"]) ?? `${workspaceName} Admin`,
              passwordHash: hashPassword(adminPassword),
              globalRole: "OPERATOR",
            },
          });

      const adminMember = await tx.member.upsert({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: adminUser.id } },
        update: { role: "ADMIN", isActive: true },
        create: { workspaceId: workspace.id, userId: adminUser.id, role: "ADMIN", isActive: true },
      });

      for (const [flag, enabled] of Object.entries(config.featureFlags)) {
        await tx.workspaceFeatureFlag.upsert({
          where: { workspaceId_flag: { workspaceId: workspace.id, flag } },
          update: { enabled, config: null },
          create: { workspaceId: workspace.id, flag, enabled, config: null },
        });
      }

      for (const policy of config.approvalPolicies ?? []) {
        await upsertApprovalPolicy(tx, workspace.id, policy.subjectType, policy.mode);
      }

      const clientMembers = [];
      const inviteResults = [];
      for (const clientUser of clientUsers) {
        const existingUser = await tx.user.findUnique({ where: { email: clientUser.email } });
        const user = existingUser
          ? await tx.user.update({
              where: { email: clientUser.email },
              data: {
                ...(clientUser.displayName !== null ? { displayName: clientUser.displayName } : {}),
              },
            })
          : await tx.user.create({
              data: {
                email: clientUser.email,
                displayName: clientUser.displayName,
                passwordHash: hashPassword(randomOpaqueToken()),
              },
            });

        const member = await tx.member.upsert({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
          update: { role: clientUser.role, isActive: true },
          create: { workspaceId: workspace.id, userId: user.id, role: clientUser.role, isActive: true },
        });

        await tx.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        const token = randomOpaqueToken();
        await tx.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        });

        const setupUrl = `${appUrl}/${defaultLocale}/setup-account/${token}`;
        inviteResults.push({ email: user.email, displayName: user.displayName, role: member.role, setupUrl });
        clientMembers.push({ user, member });
      }

      const circleMap = new Map();
      for (const circle of config.circles) {
        const saved = await ensureCircle(tx, workspace.id, circle);
        circleMap.set(circle.key, saved);
      }

      const roleMap = new Map();
      for (const role of config.roles) {
        const circle = circleMap.get(role.circleKey);
        if (!circle) throw new Error(`Unknown circle key for role '${role.name}': ${role.circleKey}`);
        const saved = await ensureRole(tx, circle.id, role);
        roleMap.set(role.key, saved);
      }

      const allMembers = [{ user: adminUser, member: adminMember }, ...clientMembers];
      for (const { member } of allMembers) {
        const roleKeys = config.roleAssignmentsByMemberRole?.[member.role] ?? [];
        for (const roleKey of roleKeys) {
          const role = roleMap.get(roleKey);
          if (!role) throw new Error(`Unknown role key in assignment map: ${roleKey}`);
          await tx.roleAssignment.upsert({
            where: { roleId_memberId: { roleId: role.id, memberId: member.id } },
            update: {},
            create: { roleId: role.id, memberId: member.id },
          });
        }
      }

      if (seedSampleData) {
        for (const article of config.brainArticles ?? []) {
          await ensureBrainArticle(tx, workspace.id, article);
        }

        const participantIds = allMembers.map(({ user }) => user.id);
        const meeting = config.meeting ? await ensureMeeting(tx, workspace.id, config.meeting, participantIds) : null;

        const actionCircle = circleMap.get(config.action?.circleKey);
        const tensionCircle = circleMap.get(config.tension?.circleKey);
        const proposalCircle = circleMap.get(config.proposal?.circleKey);
        if (config.tension) await ensureTension(tx, workspace.id, adminUser.id, adminMember.id, tensionCircle?.id ?? null, config.tension);
        if (config.action) await ensureAction(tx, workspace.id, adminUser.id, adminMember.id, actionCircle?.id ?? null, config.action);
        if (config.proposal) await ensureProposal(tx, workspace.id, adminUser.id, proposalCircle?.id ?? null, meeting?.id ?? null, config.proposal);
        if (config.finance) await ensureFinance(tx, workspace.id, adminUser.id, config.finance);

        const goalMap = new Map();
        for (const goal of config.goals ?? []) {
          const circle = goal.circleKey ? circleMap.get(goal.circleKey) : null;
          const parentGoal = goal.parentKey ? goalMap.get(goal.parentKey) : null;
          const ownerMemberId = goal.owner === "admin" ? adminMember.id : null;
          const saved = await ensureGoal(tx, workspace.id, goal, circle?.id ?? null, ownerMemberId, parentGoal?.id ?? null);
          goalMap.set(goal.key, saved);
        }
      }

      const existingAudit = await tx.auditLog.findFirst({
        where: { workspaceId: workspace.id, action: config.auditAction, entityId: workspace.id },
      });
      if (!existingAudit) {
        await tx.auditLog.create({
          data: {
            workspaceId: workspace.id,
            actorUserId: adminUser.id,
            action: config.auditAction,
            entityType: "Workspace",
            entityId: workspace.id,
            meta: {
              defaultLocale,
              featureFlags: config.featureFlags,
              sampleDataSeeded: seedSampleData,
            },
          },
        });
      }

      return { workspace, inviteResults };
    });

    for (const invite of result.inviteResults) {
      await sendInvitationEmail(config, invite.email, invite.displayName, invite.setupUrl);
    }

    console.log(`Seeded client workspace '${result.workspace.slug}' (${result.workspace.id}).`);
    console.log(`Client users processed: ${result.inviteResults.length}.`);
    if (boolFromAnyEnv([`${envPrefix}_SEND_INVITES`, "CLIENT_SEND_INVITES"])) {
      console.log("Invitation emails sent.");
    } else if (result.inviteResults.length > 0) {
      console.log("Invitation emails were not sent. Set CLIENT_SEND_INVITES=true after email configuration is verified.");
    }
    if (printInviteLinks) {
      for (const invite of result.inviteResults) {
        console.log(`${invite.email} (${invite.role}): ${invite.setupUrl}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}
