"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { updateProfileAction, updateNotificationPrefAction, updateMemberNewspaperCadenceAction } from "./actions";

type MemberNewspaperCadenceChoice = "WORKSPACE_DEFAULT" | "DAILY" | "WEEKLY" | "OFF";

function formatLocalDate(value: Date | string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
  }).format(date);
}

function formatLocalDateTime(value: Date | string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function UserSettingsPanel({
  workspaceId,
  profile,
  sessions,
  preferences,
}: {
  workspaceId: string;
  profile: any;
  sessions: any[];
  preferences: any[];
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("settings");
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newspaperCadence, setNewspaperCadence] = useState<MemberNewspaperCadenceChoice>(
    profile.member?.newspaperCadence === "DAILY" || profile.member?.newspaperCadence === "WEEKLY" || profile.member?.newspaperCadence === "OFF"
      ? profile.member.newspaperCadence
      : "WORKSPACE_DEFAULT"
  );

  // Profile Form
  const [displayName, setDisplayName] = useState(profile.user.displayName || "");
  const [bio, setBio] = useState(profile.user.bio || "");
  const [linkedinUrl, setLinkedinUrl] = useState(profile.user.linkedinUrl || "");
  const [websiteUrl, setWebsiteUrl] = useState(profile.user.websiteUrl || "");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Password Form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      await updateProfileAction(workspaceId, { displayName, bio, linkedinUrl, websiteUrl });
      router.refresh();
      // Optional: show toast
    } catch (err: any) {
      setError(err.message || "Failed to update profile");
    } finally {
      setIsSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`/api/user/avatar`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || "Upload failed");
      }

      router.refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordError(t("labelConfirmPassword") + " doesn't match.");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError(t("labelNewPassword") + " must be at least 8 chars.");
      return;
    }

    try {
      const res = await fetch(`/api/user/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || "Failed to change password");
      }

      // Logout triggers automatically on next request as token is invalid
      window.location.href = "/login?msg=password-changed";
    } catch (err: any) {
      setPasswordError(err.message);
    }
  };

  const handleSessionRevoke = async (sessionId?: string, revokeAllOther = false) => {
    try {
      const qs = revokeAllOther ? "?revokeAllOther=true" : `?sessionId=${sessionId}`;
      const res = await fetch(`/api/user/sessions${qs}`, {
        method: "DELETE",
      });
      if (res.ok) router.refresh();
    } catch (err) {
      console.error(err);
    }
  };

  const handlePrefChange = async (notifType: string, channel: string) => {
    try {
      await updateNotificationPrefAction(workspaceId, { notifType, channel });
    } catch (err) {
      console.error(err);
    }
  };

  const handleNewspaperCadenceChange = async (cadence: MemberNewspaperCadenceChoice) => {
    setNewspaperCadence(cadence);
    try {
      await updateMemberNewspaperCadenceAction(workspaceId, cadence);
    } catch (err) {
      console.error(err);
    }
  };

  const notifTypes = [
    { type: "*", label: t("notifType_*") },
    { type: "proposal.submitted", label: t("notifType_proposal_submitted") },
    { type: "meeting.created", label: t("notifType_meeting_created") },
    { type: "action.created", label: t("notifType_action_created") },
    { type: "tension.created", label: t("notifType_tension_created") },
  ];
  let memberSince = "-";
  if (profile.member) {
    memberSince = isHydrated ? formatLocalDate(profile.member.createdAt, locale) : "";
  }

  return (
    <div className="stack" style={{ gap: 40 }}>
      {/* 1. Profile Card */}
      <div className="nr-form-section">
        <h2>{t("sectionProfile")}</h2>

        {error && <div className="form-message form-message-error mb-4">{error}</div>}

        <div className="user-profile-card">
          <div
            className="avatar-upload"
            onClick={() => fileInputRef.current?.click()}
            title={t("btnUploadAvatar")}
          >
            {profile.user.avatarUrl ? (
              <span
                aria-label="Avatar"
                role="img"
                className="avatar-upload-image"
                style={{ backgroundImage: `url(${JSON.stringify(profile.user.avatarUrl)})` }}
              />
            ) : (
              <span style={{ fontSize: "2rem", fontWeight: 600, color: "var(--accent)" }}>
                {profile.user.displayName?.charAt(0)?.toUpperCase() || profile.user.email.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="avatar-overlay">
              {t("btnUploadAvatar")}
            </div>
            <input
              type="file"
              accept="image/*"
              ref={fileInputRef}
              style={{ display: "none" }}
              onChange={handleAvatarUpload}
            />
          </div>

          <form onSubmit={handleProfileSave} className="stack" style={{ flex: 1, gap: 16 }}>
            <div>
              <label>{t("labelDisplayName")}</label>
              <input
                type="text"
                className="nr-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>

            <div>
              <label>{t("labelBio")}</label>
              <textarea
                className="nr-input"
                rows={3}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Brief summary about yourself..."
              />
            </div>

            <div className="row" style={{ gap: 16, alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <label>{t("labelLinkedinUrl")}</label>
                <input
                  type="url"
                  className="nr-input"
                  value={linkedinUrl}
                  onChange={(e) => setLinkedinUrl(e.target.value)}
                  pattern="https://.*"
                  placeholder="https://www.linkedin.com/in/..."
                />
              </div>
              <div style={{ flex: 1 }}>
                <label>{t("labelWebsiteUrl")}</label>
                <input
                  type="url"
                  className="nr-input"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  pattern="https://.*"
                  placeholder="https://example.com"
                />
              </div>
            </div>

            <div className="row" style={{ gap: 16, alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <label>{t("labelEmail")}</label>
                <input type="email" className="nr-input" value={profile.user.email} disabled />
              </div>
              <div style={{ flex: 1 }}>
                <label>{t("labelMemberSince")}</label>
                <div style={{ padding: "10px 0", color: "var(--muted)" }}>
                  {memberSince}
                </div>
              </div>
            </div>

            <div>
              <button type="submit" disabled={isSaving}>{t("lblSave") || "Save"}</button>
            </div>
          </form>
        </div>
      </div>

      {/* 2. Workspace Identity */}
      {profile.member && (
        <div className="nr-form-section">
          <h2>{t("sectionWorkspaceIdentity")}</h2>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 24 }}>
            <div className="nested-item">
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Roles & Circles</label>
              {profile.member.roleAssignments.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {profile.member.roleAssignments.map((ra: any) => (
                    <li key={ra.id}>
                      <strong>{ra.role.name}</strong>
                      {ra.role.circle && <span className="text-muted"> in {ra.role.circle.name}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted">No roles assigned.</span>
              )}
            </div>

            <div className="nested-item">
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Expertise</label>
              <div className="flex flex-wrap gap-2">
                {profile.member.expertise.length > 0 ? (
                  profile.member.expertise.map((exp: any) => (
                    <span key={exp.id} className="tag">
                      {exp.expertiseTag.name} {exp.endorsedCount > 0 && `(${exp.endorsedCount})`}
                    </span>
                  ))
                ) : (
                  <span className="text-muted">No expertise claimed.</span>
                )}
              </div>
            </div>

            <div className="nested-item">
              <label style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>Recent Recognitions</label>
              {profile.member.recognitionsReceived && profile.member.recognitionsReceived.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {profile.member.recognitionsReceived.map((rec: any) => (
                    <li key={rec.id} style={{ marginBottom: 4, fontSize: '0.9rem' }}>
                      <span className="text-muted">From {rec.author?.user?.displayName || "Someone"}:</span> <em>&quot;{rec.message}&quot;</em>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted">No recognitions yet.</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 3. Notifications */}
      <div className="nr-form-section">
        <h2>{t("sectionNotifications")}</h2>
        <div className="nested-item" style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>
            {t("labelNewspaperCadence")}
          </label>
          <select
            className="nr-input"
            style={{ maxWidth: 280 }}
            value={newspaperCadence}
            onChange={(e) => handleNewspaperCadenceChange(e.target.value as MemberNewspaperCadenceChoice)}
          >
            <option value="WORKSPACE_DEFAULT">{t("newspaperCadenceWorkspaceDefault")}</option>
            <option value="DAILY">{t("newspaperCadenceDaily")}</option>
            <option value="WEEKLY">{t("newspaperCadenceWeekly")}</option>
            <option value="OFF">{t("newspaperCadenceOff")}</option>
          </select>
          <p className="text-muted mt-2 text-[0.85rem]">{t("newspaperCadenceMemberHelp")}</p>
        </div>
        <div className="nested-item" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="notif-pref-table">
            <tbody>
              {notifTypes.map(nt => {
                const pref = preferences.find(p => p.notifType === nt.type);
                const currentVal = pref ? pref.channel : (nt.type === "*" ? "IN_APP" : "USE_DEFAULT");

                return (
                  <tr key={nt.type}>
                    <td style={{ fontWeight: nt.type === "*" ? 600 : 400 }}>{nt.label}</td>
                    <td style={{ width: 180 }}>
                      <select
                        className="nr-input"
                        style={{ padding: "6px 10px" }}
                        value={currentVal}
                        onChange={(e) => handlePrefChange(nt.type, e.target.value)}
                      >
                        {nt.type !== "*" && <option value="USE_DEFAULT">Use Default</option>}
                        <option value="IN_APP">{t("notifChannel_IN_APP")}</option>
                        <option value="EMAIL">{t("notifChannel_EMAIL")}</option>
                        <option value="BOTH">{t("notifChannel_BOTH")}</option>
                        <option value="OFF">{t("notifChannel_OFF")}</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-muted mt-2 text-[0.85rem]">Slack integration coming soon.</p>
      </div>

      {/* 4. Security */}
      <div className="nr-form-section">
        <h2>{t("sectionSecurity")}</h2>

        <div className="nested-item mb-6">
          <label style={{ display: 'block', marginBottom: 16, fontWeight: 600 }}>{t("btnChangePassword")}</label>

          {passwordError && <div className="form-message form-message-error mb-4">{passwordError}</div>}

          <form onSubmit={handlePasswordSubmit} className="stack" style={{ gap: 16 }}>
            <div>
              <input
                type="password"
                className="nr-input"
                placeholder={t("labelCurrentPassword")}
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="row" style={{ gap: 16 }}>
              <input
                type="password"
                className="nr-input"
                placeholder={t("labelNewPassword")}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                required
              />
              <input
                type="password"
                className="nr-input"
                placeholder={t("labelConfirmPassword")}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <div>
              <button type="submit" className="small">{t("btnChangePassword")}</button>
            </div>
          </form>
        </div>

        <div className="nested-item">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <label style={{ fontWeight: 600, margin: 0 }}>Active Sessions</label>
            <button
              className="danger small"
              onClick={() => handleSessionRevoke(undefined, true)}
              disabled={sessions.length <= 1}
            >
              {t("btnRevokeAllSessions")}
            </button>
          </div>

          <div className="session-list">
            {sessions.map(s => {
              // Parse User Agent basically
              const browser = s.userAgent?.includes("Chrome") ? "Chrome" : s.userAgent?.includes("Firefox") ? "Firefox" : s.userAgent?.includes("Safari") ? "Safari" : "Browser";
              const os = s.userAgent?.includes("Mac") ? "macOS" : s.userAgent?.includes("Win") ? "Windows" : s.userAgent?.includes("Linux") ? "Linux" : "Unknown OS";

              return (
                <div key={s.id} className="session-card">
                  <div>
                    <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <strong style={{ fontSize: '0.95rem' }}>{browser} on {os}</strong>
                      {s.isCurrent && <span className="status-chip" style={{ padding: '2px 6px', fontSize: '0.65rem' }}>{t("sessionCurrent")}</span>}
                    </div>
                    <div className="text-muted" style={{ fontSize: '0.8rem', display: 'flex', gap: 16 }}>
                      <span>IP: {s.ipAddress || "Unknown"}</span>
                      <span>Last active: {isHydrated ? formatLocalDateTime(s.lastSeenAt, locale) : ""}</span>
                    </div>
                  </div>
                  {!s.isCurrent && (
                    <button className="secondary small" onClick={() => handleSessionRevoke(s.id)}>
                      {t("btnRevokeSession")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
