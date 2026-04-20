"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { loginAction } from "./actions";
import { initialLoginActionState } from "./state";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "Logging in..." : "Login"}
    </button>
  );
}

export function LoginForm() {
  const [state, formAction] = useActionState(loginAction, initialLoginActionState);

  return (
    <form action={formAction} className="stack" style={{ marginTop: 20 }}>
      <label>
        Email
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.email}
        />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="current-password"
        />
      </label>
      <div style={{ textAlign: "right", marginTop: -4 }}>
        <Link href="/forgot-password" className="muted" style={{ fontSize: 13 }}>
          Forgot password?
        </Link>
      </div>
      {state.error ? (
        <p className="form-message form-message-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <SubmitButton />
    </form>
  );
}
