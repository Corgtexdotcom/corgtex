import { invariant } from "./errors";

export function isReservedPublicDemoEmail(email: string | undefined) {
  return email?.trim().toLowerCase() === "demo@jnj-demo.corgtex.app";
}

export function requireUnreservedPublicDemoEmail(email: string | undefined) {
  invariant(!isReservedPublicDemoEmail(email), 400, "RESERVED_IDENTITY", "The public demo account is reserved for its dedicated workspace.");
}
