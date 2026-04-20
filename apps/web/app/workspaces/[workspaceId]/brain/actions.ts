"use server";

import { enforceDemoGuard } from "@/lib/demo-guard";

import type { BrainArticleAuthority, BrainArticleType, BrainDiscussionTargetType, BrainSourceType } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  createArticle,
  updateArticle,
  deleteArticle,
  ingestSource,
  createDiscussionThread,
  addDiscussionComment,
  resolveDiscussionThread,
  publishArticle,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

function asString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function asOptional(formData: FormData, key: string) {
  const value = asString(formData, key).trim();
  return value.length > 0 ? value : null;
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
  await createArticle(actor, {
    workspaceId,
    title: asString(formData, "title"),
    slug: asOptional(formData, "slug") ?? undefined,
    type: (asString(formData, "type") || "GLOSSARY") as BrainArticleType,
    authority: (asOptional(formData, "authority") ?? "DRAFT") as BrainArticleAuthority,
    bodyMd: asString(formData, "bodyMd"),
    isPrivate: formData.get("isPrivate") === "on",
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

export async function deleteArticleAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await deleteArticle(actor, {
    workspaceId,
    slug: asString(formData, "slug"),
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

export async function createDiscussionAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await createDiscussionThread(actor, {
    workspaceId,
    slug: asString(formData, "slug"),
    targetType: (asOptional(formData, "targetType") ?? "ARTICLE") as BrainDiscussionTargetType,
    targetRef: asOptional(formData, "targetRef"),
    bodyMd: asString(formData, "bodyMd"),
  });
  refresh(workspaceId);
}

export async function addCommentAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await addDiscussionComment(actor, {
    workspaceId,
    threadId: asString(formData, "threadId"),
    bodyMd: asString(formData, "bodyMd"),
  });
  refresh(workspaceId);
}

export async function resolveThreadAction(formData: FormData) {
  const _demoGuardWsId = formData.get("workspaceId") as string;
  if (_demoGuardWsId) await enforceDemoGuard(_demoGuardWsId);

  const actor = await requirePageActor();
  const workspaceId = asString(formData, "workspaceId");
  await resolveDiscussionThread(actor, {
    workspaceId,
    threadId: asString(formData, "threadId"),
  });
  refresh(workspaceId);
}
