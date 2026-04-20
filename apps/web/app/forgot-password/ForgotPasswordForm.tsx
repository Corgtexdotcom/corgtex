"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { forgotPasswordAction } from "./actions";
import { initialForgotPasswordState } from "./state";
import Link from "next/link";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "Sending..." : "Send Reset Link"}
    </button>
  );
}

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(forgotPasswordAction, initialForgotPasswordState);

  if (state.success) {
    return (
      <div className="stack" style={{ marginTop: 20 }}>
        <div className="form-message form-message-success" role="status">
          <p style={{ fontWeight: 500, marginBottom: 4 }}>Check your email</p>
          <p className="muted" style={{ fontSize: 14 }}>
            If an account with that email exists, we&apos;ve sent a password reset link.
            The link expires in 15 minutes.
          </p>
        </div>
        <Link href="/login" style={{ marginTop: 12, display: "inline-block" }}>
          ← Back to login
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="stack" style={{ marginTop: 20 }}>
      <p className="muted" style={{ fontSize: 14, marginBottom: 8 }}>
        Enter your email address and we&apos;ll send you a link to reset your password.
      </p>
      <label>
        Email
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.email}
          autoFocus
        />
      </label>
      {state.error ? (
        <p className="form-message form-message-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <SubmitButton />
      <Link href="/login" className="muted" style={{ fontSize: 14, marginTop: 8, display: "inline-block" }}>
        ← Back to login
      </Link>
    </form>
  );
}
