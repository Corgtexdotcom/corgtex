import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS_WITH_IMAGES = sanitizeHtml.defaults.allowedTags.concat([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "img",
]);

const ALLOWED_TAGS_WITHOUT_IMAGES = ALLOWED_TAGS_WITH_IMAGES.filter((tag) => tag !== "img");

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  ...sanitizeHtml.defaults.allowedAttributes,
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "title"],
};

export function renderMarkdown(md: string, opts?: { allowImages?: boolean }): string {
  const html = marked.parse(md, { async: false }) as string;
  const allowImages = opts?.allowImages ?? true;
  return sanitizeHtml(html, {
    allowedTags: allowImages ? ALLOWED_TAGS_WITH_IMAGES : ALLOWED_TAGS_WITHOUT_IMAGES,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "nofollow noopener noreferrer" }, true),
    },
  });
}

export function markdownToPlainText(md: string, maxLength = 360): string {
  const html = marked.parse(md, { async: false }) as string;
  const text = sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(/\s+/g, " ").trim();

  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}
