"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";

import type { BrainArticleAuthority, BrainArticleType, BrainSourceType } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  createArticle,
  updateArticle,
  ingestSource,
  publishArticle,
  requireWorkspaceMembership,
  returnArticleToDraft,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

function asString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function asOptional(formData: FormData, key: string) {
  const value = asString(formData, key).trim();
  return value.length > 0 ? value : null;
}

function isWorkingAgreementCapture(formData: FormData) {
  return asString(formData, "agreementCapture") === "working-agreement";
}

function workingAgreementFrontmatter(formData: FormData) {
  if (!isWorkingAgreementCapture(formData)) return undefined;

  const source = asOptional(formData, "agreementSource");
  const context = asOptional(formData, "agreementContext");
  const workingAgreement: Record<string, string> = {};
  if (source) workingAgreement.source = source;
  if (context) workingAgreement.context = context;

  return { workingAgreement };
}

function persistedOwnerMemberId(membership: { id: string } | null | undefined) {
  return membership?.id === "global-operator" ? null : membership?.id ?? null;
}

function refresh(workspaceId: string, slug?: string) {
  revalidatePath(`/workspaces/${workspaceId}/brain`);
  if (slug) {
    revalidatePath(`/workspaces/${workspaceId}/brain/${slug}`);
  }
}

export async function createArticleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const isWorkingAgreement = isWorkingAgreementCapture(formData);
  const isPrivate = formData.get("isPrivate") === "on";
  const membership = isWorkingAgreement
    ? await requireWorkspaceMembership({ actor, workspaceId })
    : null;
  await createArticle(actor, {
    workspaceId,
    title: asString(formData, "title"),
    slug: asOptional(formData, "slug") ?? undefined,
    type: (asString(formData, "type") || "GLOSSARY") as BrainArticleType,
    authority: (isWorkingAgreement && isPrivate ? "DRAFT" : asOptional(formData, "authority") ?? "DRAFT") as BrainArticleAuthority,
    bodyMd: asString(formData, "bodyMd"),
    frontmatterJson: workingAgreementFrontmatter(formData),
    ownerMemberId: isWorkingAgreement ? persistedOwnerMemberId(membership) : undefined,
    isPrivate,
  });
  refresh(workspaceId);
}

export async function publishArticleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await publishArticle(actor, {
    workspaceId,
    slug: asString(formData, "slug"),
  });
  refresh(workspaceId, asString(formData, "slug"));
}

export async function returnArticleToDraftAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await returnArticleToDraft(actor, {
    workspaceId,
    slug: asString(formData, "slug"),
  });
  refresh(workspaceId, asString(formData, "slug"));
}

export async function updateArticleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  const slug = asString(formData, "slug");
  await updateArticle(actor, {
    workspaceId,
    slug,
    title: asOptional(formData, "title") ?? undefined,
    type: asOptional(formData, "type") as BrainArticleType | undefined ?? undefined,
    authority: asOptional(formData, "authority") as BrainArticleAuthority | undefined ?? undefined,
    bodyMd: formData.has("bodyMd") ? asString(formData, "bodyMd") : undefined,
    changeSummary: asOptional(formData, "changeSummary") ?? undefined,
  });
  refresh(workspaceId);
}

export async function ingestSourceAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await ingestSource(actor, {
    workspaceId,
    sourceType: (asString(formData, "sourceType") || "DOC") as BrainSourceType,
    tier: Number(asString(formData, "tier")) || 1,
    content: asString(formData, "content"),
    title: asOptional(formData, "title"),
    channel: asOptional(formData, "channel"),
  });
  refresh(workspaceId);
}
