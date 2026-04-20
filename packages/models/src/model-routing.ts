import { env } from "@corgtex/shared";

export type ModelTier = "fast" | "standard" | "quality" | "none";

export function resolveModel(tier: ModelTier, override?: string | null): string {
  if (override) return override;
  switch (tier) {
    case "fast":     return env.MODEL_CHAT_FAST;
    case "standard": return env.MODEL_CHAT_STANDARD;
    case "quality":  return env.MODEL_CHAT_QUALITY;
    case "none":     return env.MODEL_CHAT_DEFAULT;
  }
}
