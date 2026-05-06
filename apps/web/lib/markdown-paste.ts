import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
});

turndown.addRule("styledStrong", {
  filter: (node) => {
    const style = node.getAttribute?.("style") ?? "";
    return node.nodeName === "SPAN" && /font-weight:\s*(bold|[6-9]00)/i.test(style);
  },
  replacement: (content) => {
    const trimmed = content.trim();
    return trimmed ? `**${trimmed}**` : "";
  },
});

turndown.addRule("styledEmphasis", {
  filter: (node) => {
    const style = node.getAttribute?.("style") ?? "";
    return node.nodeName === "SPAN" && /font-style:\s*italic/i.test(style);
  },
  replacement: (content) => {
    const trimmed = content.trim();
    return trimmed ? `_${trimmed}_` : "";
  },
});

export function htmlToMarkdown(html: string): string {
  if (!html.trim() || !/<[a-z][\s\S]*>/i.test(html)) return "";

  return turndown
    .turndown(html)
    .replace(/\u00a0/g, " ")
    .replace(/^([ \t]*[-*+]) {2,}/gm, "$1 ")
    .replace(/^([ \t]*\d+\.) {2,}/gm, "$1 ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
