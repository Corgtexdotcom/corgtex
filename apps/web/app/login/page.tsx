import { LoginForm } from "./LoginForm";
import { DemoButton } from "./DemoButton";
function singleSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function pageErrorMessage(rawError: string | string[] | undefined) {
  const error = singleSearchParam(rawError);
  if (error === "session-unavailable") {
    return "Session is temporarily unavailable. Try again.";
  }

  return null;
}

function pageSuccessMessage(rawMessage: string | string[] | undefined) {
  const message = singleSearchParam(rawMessage);
  if (message === "password-reset") {
    return "Your password has been reset. Please log in with your new password.";
  }

  return null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const pageError = pageErrorMessage(resolvedSearchParams.error);
  const pageSuccess = pageSuccessMessage(resolvedSearchParams.message);

  return (
    <main className="login-shell">
      <section className="panel login-card">
        <span className="tag">Corgtex</span>
        <h1 style={{ marginTop: 16 }}>Welcome to Corgtex</h1>
        <p className="muted" style={{ marginBottom: "20px" }}>
          Your organization&apos;s operating system. Log in to access your workspace.
        </p>

        {pageSuccess ? (
          <p className="form-message form-message-success" role="status" style={{ marginTop: 20 }}>
            {pageSuccess}
          </p>
        ) : null}

        {pageError ? (
          <p className="form-message form-message-error" role="alert" style={{ marginTop: 20 }}>
            {pageError}
          </p>
        ) : null}

        <LoginForm />
        <DemoButton />
      </section>
    </main>
  );
}
