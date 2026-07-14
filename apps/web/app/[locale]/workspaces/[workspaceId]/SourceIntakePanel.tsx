"use client";

import { useTranslations } from "next-intl";

import { KnowledgeFileUploader } from "./KnowledgeFileUploader";
import { TextPasteUploader } from "./settings/TextPasteUploader";
import { GoogleDrivePicker } from "./tools/GoogleDrivePicker";

type GoogleDrivePickerConfig = {
  clientId: string | null;
  developerKey: string | null;
  appId: string | null;
  hasDocumentScope: boolean;
  initialSelectedIds: string[];
};

export function SourceIntakePanel({
  workspaceId,
  uploadDefaultSource = "brain-upload",
  uploadDoneLabel,
  uploadCancelHref,
  googleDrivePicker,
  googleDriveConnectHref,
  openGoogleDrivePicker = false,
  className,
  onUploaded,
  onDone,
  onDriveSynced,
}: {
  workspaceId: string;
  uploadDefaultSource?: string;
  uploadDoneLabel?: string;
  uploadCancelHref?: string;
  googleDrivePicker?: GoogleDrivePickerConfig;
  googleDriveConnectHref?: string;
  openGoogleDrivePicker?: boolean;
  className?: string;
  onUploaded?: (count: number) => void;
  onDone?: () => void;
  onDriveSynced?: (count: number) => void;
}) {
  const t = useTranslations("sourceIntake");
  const showGoogleDrive = Boolean(googleDrivePicker || googleDriveConnectHref);

  return (
    <div className={`source-intake-panel stack ${className ?? ""}`.trim()}>
      <section className="source-intake-section stack">
        <KnowledgeFileUploader
          workspaceId={workspaceId}
          defaultSource={uploadDefaultSource}
          initiallyOpen
          showTrigger={false}
          heading={t("uploadTitle")}
          description={t("uploadDescription")}
          surface="embedded"
          doneLabel={uploadDoneLabel}
          cancelHref={uploadCancelHref}
          onUploaded={onUploaded}
          onDone={onDone}
        />
      </section>

      <section className="source-intake-section stack">
        <TextPasteUploader
          workspaceId={workspaceId}
          heading={t("pasteTitle")}
          description={t("pasteDescription")}
          surface="embedded"
        />
      </section>

      {showGoogleDrive && (
        <section className="source-intake-section stack">
          <div>
            <h3>{t("driveTitle")}</h3>
            <p className="nr-item-meta">{t("driveDescription")}</p>
          </div>
          {googleDrivePicker?.hasDocumentScope ? (
            <GoogleDrivePicker
              workspaceId={workspaceId}
              clientId={googleDrivePicker.clientId}
              developerKey={googleDrivePicker.developerKey}
              appId={googleDrivePicker.appId}
              initialSelectedIds={googleDrivePicker.initialSelectedIds}
              autoOpen={openGoogleDrivePicker}
              onSynced={onDriveSynced}
              labels={{
                selectedTitle: t("driveSelectedTitle"),
                chooseAction: t("driveChooseAction"),
                openingAction: t("driveOpeningAction"),
                description: t("drivePickerDescription"),
                syncQueued: t("driveSyncQueued"),
                missingConfig: t("driveMissingConfig"),
                syncError: t("driveSyncError"),
                openError: t("driveOpenError"),
              }}
            />
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <p className="nr-item-meta" style={{ margin: 0 }}>
                {t("driveConnectDescription")}
              </p>
              {googleDriveConnectHref && (
                <a className="button secondary small" href={googleDriveConnectHref}>
                  {t("driveConnectAction")}
                </a>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
