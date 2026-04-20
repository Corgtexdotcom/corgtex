import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <main className="login-shell">
      <section className="panel login-card">
        <span className="tag">Corgtex</span>
        <h1 style={{ marginTop: 16 }}>Set New Password</h1>
        <p className="muted">
          Choose a new password for your account.
        </p>

        <ResetPasswordForm token={token} />
      </section>
    </main>
  );
}
