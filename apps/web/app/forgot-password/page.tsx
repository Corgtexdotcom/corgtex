import { ForgotPasswordForm } from "./ForgotPasswordForm";

export default function ForgotPasswordPage() {
  return (
    <main className="login-shell">
      <section className="panel login-card">
        <span className="tag">Corgtex</span>
        <h1 style={{ marginTop: 16 }}>Reset Password</h1>
        <p className="muted">
          Forgot your password? No worries — we&apos;ll send you a reset link.
        </p>

        <ForgotPasswordForm />
      </section>
    </main>
  );
}
