export function validationEmails(env) {
  const adminEmail = env.VALIDATION_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const memberEmail = env.QA_VALIDATION_MEMBER_EMAIL?.trim().toLowerCase();
  if (!adminEmail || !memberEmail) throw new Error("Set explicit validation administrator and QA member emails");
  if (adminEmail === memberEmail) throw new Error("QA member and administrator must be separate identities");
  return { adminEmail, memberEmail };
}
