import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = sanitizeHtml.defaults.allowedTags.concat([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "img",
]);

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  ...sanitizeHtml.defaults.allowedAttributes,
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "title"],
};

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "nofollow noopener noreferrer" }, true),
    },
  });
}
