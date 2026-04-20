import { prisma, hashPassword, randomOpaqueToken, sha256 } from "@corgtex/shared";
import { AppError, invariant } from "./errors";

const RESET_TOKEN_TTL_MS = 1000 * 60 * 15; // 15 minutes

/**
 * Generate a password reset token for the given email.
 * Returns null silently if the user doesn't exist (prevents enumeration).
 * Invalidates any existing unused tokens for this user.
 */
export async function requestPasswordReset(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  invariant(normalizedEmail.length > 0, 400, "INVALID_INPUT", "Email is required.");

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, displayName: true },
  });

  if (!user) {
    // Silently return null — caller should still return 200 to prevent enumeration
    return null;
  }

  // Invalidate any existing unused tokens for this user
  await prisma.passwordResetToken.updateMany({
    where: {
      userId: user.id,
      usedAt: null,
    },
    data: {
      usedAt: new Date(),
    },
  });

  const token = randomOpaqueToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt,
    },
  });

  return { token, user };
}

/**
 * Consume a password reset token and update the user's password.
 * Invalidates all existing sessions for the user (forces re-login).
 */
export async function consumePasswordReset(params: { token: string; newPassword: string }) {
  invariant(params.token.length > 0, 400, "INVALID_INPUT", "Reset token is required.");
  invariant(params.newPassword.length >= 8, 400, "INVALID_INPUT", "Password must be at least 8 characters.");

  const tokenHash = sha256(params.token);

  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      usedAt: true,
    },
  });

  if (!resetToken) {
    throw new AppError(400, "INVALID_TOKEN", "This reset link is invalid or has expired.");
  }

  if (resetToken.usedAt) {
    throw new AppError(400, "TOKEN_USED", "This reset link has already been used.");
  }

  if (resetToken.expiresAt <= new Date()) {
    throw new AppError(400, "TOKEN_EXPIRED", "This reset link has expired. Please request a new one.");
  }

  // Update password, mark token as used, and invalidate all sessions in a transaction
  await prisma.$transaction([
    prisma.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash: hashPassword(params.newPassword) },
    }),
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    }),
    prisma.session.deleteMany({
      where: { userId: resetToken.userId },
    }),
  ]);

  return { success: true };
}
