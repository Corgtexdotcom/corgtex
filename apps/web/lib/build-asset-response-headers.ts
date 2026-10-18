/** Keep executable uploads downloadable while allowing inert image previews. */
export function buildAssetResponseHeaders(mimeType: string | null | undefined) {
  const type = mimeType?.trim().toLowerCase();
  const previewable = type !== undefined && new Set([
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon",
  ]).has(type);
  const validType = type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type);
  return {
    "Content-Type": validType ? type : "application/octet-stream",
    "Content-Disposition": previewable ? "inline" : "attachment",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
