"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { setupAccountAction } from "./actions";
import { initialResetPasswordState } from "./state";
import Link from "next/link";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "Setting up..." : "Set Password"}
    </button>
  );
}

export function SetupAccountForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(setupAccountAction, initialResetPasswordState);

  return (
    <form action={formAction} className="stack" style={{ marginTop: 20 }}>
      <input type="hidden" name="token" value={token} />
      <label>
        New Password
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          autoFocus
        />
      </label>
      <label>
        Confirm Password
        <input
          name="confirmPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
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
