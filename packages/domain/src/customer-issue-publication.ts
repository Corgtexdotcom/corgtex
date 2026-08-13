/**
 * Fail-closed customer issue publication contract.
 *
 * Serializes an explicitly published customer issue into a narrowly
 * allowlisted, revisioned ALL_CUSTOMERS projection. Any invalid,
 * incomplete, unpublished, or unauthorized input returns null. The
 * serializer never repairs, coerces, trims, defaults, or partially
 * serializes input, and never exposes private Action, reporter,
 * workspace, evidence, URL, assignment, comment, or operational data.
 */

export const CUSTOMER_ISSUE_AUDIENCE_ALL_CUSTOMERS = "ALL_CUSTOMERS" as const;

export type CustomerIssueAudience = typeof CUSTOMER_ISSUE_AUDIENCE_ALL_CUSTOMERS;

export const CUSTOMER_ISSUE_PUBLIC_STATUSES = Object.freeze([
  "INVESTIGATING",
  "PLANNED",
  "IN_PROGRESS",
  "MONITORING",
  "RESOLVED",
] as const);

export type CustomerIssuePublicStatus =
  (typeof CUSTOMER_ISSUE_PUBLIC_STATUSES)[number];

export interface CustomerIssuePublicProjection {
  slug: string;
  title: string;
  summary: string;
  status: CustomerIssuePublicStatus;
  audience: CustomerIssueAudience;
  revision: number;
  publishedAt: string;
}

const PUBLICATION_STATE_PUBLISHED = "PUBLISHED";

const PUBLIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLIC_SLUG_MAX_LENGTH = 120;
const PUBLIC_TITLE_MAX_LENGTH = 160;
const PUBLIC_SUMMARY_MAX_LENGTH = 2000;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOwn(record: Record<string, unknown>, key: string): [boolean, unknown] {
  if (!Object.hasOwn(record, key)) return [false, undefined];
  return [true, record[key]];
}

function isCanonicalSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= PUBLIC_SLUG_MAX_LENGTH &&
    PUBLIC_SLUG_PATTERN.test(value)
  );
}

function isTrimmedBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= maxLength &&
    value.trim() === value
  );
}

function isPublicStatus(value: unknown): value is CustomerIssuePublicStatus {
  return (
    typeof value === "string" &&
    (CUSTOMER_ISSUE_PUBLIC_STATUSES as readonly string[]).includes(value)
  );
}

function isValidRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isCanonicalUtcIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function serializeCustomerIssuePublication(
  value: unknown,
): CustomerIssuePublicProjection | null {
  try {
    if (!isRecord(value)) return null;
    const [hasState, publicationState] = readOwn(value, "publicationState");
    if (!hasState || publicationState !== PUBLICATION_STATE_PUBLISHED) return null;
    const [hasAudience, audience] = readOwn(value, "audience");
    if (!hasAudience || audience !== CUSTOMER_ISSUE_AUDIENCE_ALL_CUSTOMERS) return null;
    const [hasSlug, publicSlug] = readOwn(value, "publicSlug");
    if (!hasSlug || !isCanonicalSlug(publicSlug)) return null;
    const [hasTitle, publicTitle] = readOwn(value, "publicTitle");
    if (!hasTitle || !isTrimmedBoundedText(publicTitle, PUBLIC_TITLE_MAX_LENGTH)) return null;
    const [hasSummary, publicSummary] = readOwn(value, "publicSummary");
    if (!hasSummary || !isTrimmedBoundedText(publicSummary, PUBLIC_SUMMARY_MAX_LENGTH)) return null;
    const [hasStatus, publicStatus] = readOwn(value, "publicStatus");
    if (!hasStatus || !isPublicStatus(publicStatus)) return null;
    const [hasRevision, revision] = readOwn(value, "revision");
    if (!hasRevision || !isValidRevision(revision)) return null;
    const [hasPublishedAt, publishedAt] = readOwn(value, "publishedAt");
    if (!hasPublishedAt || !isCanonicalUtcIsoInstant(publishedAt)) return null;
    return {
      slug: publicSlug, title: publicTitle, summary: publicSummary,
      status: publicStatus, audience, revision, publishedAt,
    };
  } catch {
    return null;
  }
}
