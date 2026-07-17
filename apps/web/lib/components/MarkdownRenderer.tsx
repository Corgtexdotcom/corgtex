import { markdownToPlainText, renderMarkdown } from "@/lib/markdown";

type MarkdownVariant = "document" | "compact";

export function MarkdownRenderer({
  markdown,
  variant = "document",
  className = "",
  allowImages = true,
}: {
  markdown?: string | null;
  variant?: MarkdownVariant;
  className?: string;
  allowImages?: boolean;
}) {
  if (!markdown?.trim()) return null;

  return (
    <div
      className={`markdown-body markdown-body-${variant} ${className}`.trim()}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown, { allowImages }) }}
    />
  );
}

export function MarkdownExcerpt({
  markdown,
  maxLength = 180,
  className = "",
  as = "span",
}: {
  markdown?: string | null;
  maxLength?: number;
  className?: string;
  as?: "span" | "p" | "div";
}) {
  const text = markdown ? markdownToPlainText(markdown, maxLength) : "";
  if (!text) return null;

  const classes = `markdown-excerpt ${className}`.trim();
  if (as === "p") return <p className={classes}>{text}</p>;
  if (as === "div") return <div className={classes}>{text}</div>;
  return <span className={classes}>{text}</span>;
}
