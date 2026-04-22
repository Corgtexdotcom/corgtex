import { SetupAccountForm } from "./SetupAccountForm";

export default async function SetupAccountPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <main className="login-shell">
      <section className="panel login-card">
        <span className="tag">Corgtex</span>
        <h1 style={{ marginTop: 16 }}>Set Up Account</h1>
        <p className="muted">
          Choose a secure password to activate your account.
        </p>

        <SetupAccountForm token={token} />
      </section>
    </main>
  );
}
