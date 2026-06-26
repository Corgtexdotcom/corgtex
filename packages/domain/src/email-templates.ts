export type AccountAccessEmailKind =
  | "trial-claim"
  | "member-invite"
  | "admin-added"
  | "resend-access";

export type PasswordResetEmailKind =
  | "self-service"
  | "existing-account"
  | "admin-triggered";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}

function safeText(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function renderButton(url: string, label: string) {
  return `
    <div style="margin: 28px 0 30px;">
      <a href="${escapeAttribute(url)}" style="background-color: #111; color: #fff; padding: 13px 22px; border-radius: 7px; text-decoration: none; display: inline-block; font-weight: 600;">
        ${escapeHtml(label)}
      </a>
    </div>
  `;
}

function renderProductEmailShell(params: {
  eyebrow?: string;
  title: string;
  bodyHtml: string;
}) {
  const eyebrow = params.eyebrow
    ? `<div style="font-size: 12px; letter-spacing: 0.9px; text-transform: uppercase; color: #6b6258; margin-bottom: 10px;">${escapeHtml(params.eyebrow)}</div>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f6f2ea;color:#1f1d1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f2ea;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#fffaf3;border:1px solid #e1d8c8;border-radius:8px;">
            <tr>
              <td style="padding:34px 34px 28px;">
                ${eyebrow}
                <h1 style="font-size:28px;line-height:1.15;margin:0 0 18px;color:#111;font-weight:700;">${escapeHtml(params.title)}</h1>
                ${params.bodyHtml}
                <div style="margin-top:30px;padding-top:18px;border-top:1px solid #e5ddcf;color:#80766a;font-size:13px;line-height:1.5;">
                  Corgtex keeps workspace memory, decisions, actions, meetings, and AI work visible in one operating picture.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderAccountSetupEmail(params: {
  setupUrl: string;
  displayName?: string | null;
  workspaceName?: string | null;
  kind?: AccountAccessEmailKind;
}) {
  const kind = params.kind ?? "member-invite";
  const recipient = escapeHtml(safeText(params.displayName, "there"));
  const workspaceName = escapeHtml(safeText(params.workspaceName, "your Corgtex workspace"));
  const title = kind === "trial-claim"
    ? "Your Corgtex workspace is ready"
    : kind === "resend-access"
      ? "Here is your Corgtex setup link"
      : "Join Corgtex";
  const intro = kind === "trial-claim"
    ? `${workspaceName} is ready. Use this secure link to set your password and step inside.`
    : kind === "admin-added"
      ? `An administrator added you to ${workspaceName} on Corgtex.`
      : kind === "resend-access"
        ? `A fresh setup link was requested for your account in ${workspaceName}.`
        : `You have been invited to join ${workspaceName} on Corgtex.`;

  return renderProductEmailShell({
    eyebrow: "Corgtex account setup",
    title,
    bodyHtml: `
      <p style="font-size:16px;line-height:1.6;margin:0 0 14px;color:#2d2a24;">Hi ${recipient},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 18px;color:#2d2a24;">${intro}</p>
      ${renderButton(params.setupUrl, "Set up your account")}
      <div style="background:#f4efe5;border:1px solid #e2d7c5;border-radius:7px;padding:18px 20px;margin:0 0 18px;">
        <div style="font-size:13px;letter-spacing:0.7px;text-transform:uppercase;color:#6b6258;margin-bottom:10px;">What happens next</div>
        <ol style="margin:0;padding-left:20px;color:#2d2a24;font-size:15px;line-height:1.65;">
          <li>Set your password with the secure setup link.</li>
          <li>Start with the workspace newspaper to see recent context, decisions, meetings, tensions, and actions.</li>
          <li>Bring in teammates and useful company context when you are ready.</li>
        </ol>
      </div>
      <p style="font-size:14px;line-height:1.55;margin:0;color:#6b6258;">If this was not expected, you can ignore this email. The setup link is only for this account.</p>
    `,
  });
}

export function renderPasswordResetEmail(params: {
  resetUrl: string;
  displayName?: string | null;
  kind?: PasswordResetEmailKind;
}) {
  const kind = params.kind ?? "self-service";
  const recipient = escapeHtml(safeText(params.displayName, "there"));
  const intro = kind === "admin-triggered"
    ? "A Corgtex administrator requested a password reset for your account."
    : kind === "existing-account"
      ? "It looks like you already have a Corgtex account. Reset your password, then you can continue into your workspace."
      : "We received a request to reset your Corgtex password. Click the button below to choose a new password.";

  return renderProductEmailShell({
    eyebrow: "Corgtex account access",
    title: "Reset your password",
    bodyHtml: `
      <p style="font-size:16px;line-height:1.6;margin:0 0 14px;color:#2d2a24;">Hi ${recipient},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 18px;color:#2d2a24;">${intro}</p>
      ${renderButton(params.resetUrl, "Reset password")}
      <p style="color:#6b6258;font-size:14px;line-height:1.55;margin:0;">This link expires in 15 minutes. If you did not request this, you can safely ignore this email.</p>
    `,
  });
}

export function renderPasswordResetEmailText(params: {
  resetUrl: string;
  displayName?: string | null;
  kind?: PasswordResetEmailKind;
}) {
  const kind = params.kind ?? "self-service";
  const recipient = safeText(params.displayName, "there");
  const intro = kind === "admin-triggered"
    ? "A Corgtex administrator requested a password reset for your account."
    : kind === "existing-account"
      ? "It looks like you already have a Corgtex account. Reset your password, then you can continue into your workspace."
      : "We received a request to reset your Corgtex password.";

  return [
    `Hi ${recipient},`,
    "",
    intro,
    "",
    "Choose a new password using this secure link:",
    params.resetUrl,
    "",
    "This link expires in 15 minutes. If you did not request this, you can safely ignore this email.",
  ].join("\n");
}
