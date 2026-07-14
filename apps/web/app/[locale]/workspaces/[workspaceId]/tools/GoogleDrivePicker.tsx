"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

declare global {
  interface Window {
    gapi?: {
      load: (api: string, callback: () => void) => void;
    };
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
          }) => {
            requestAccessToken: (options?: { prompt?: string }) => void;
          };
        };
      };
      picker?: any;
    };
  }
}

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export type GoogleDrivePickerLabels = {
  selectedTitle: string;
  chooseAction: string;
  openingAction: string;
  description: string;
  syncQueued: string;
  missingConfig: string;
  syncError: string;
  openError: string;
};

const DEFAULT_GOOGLE_DRIVE_PICKER_LABELS: GoogleDrivePickerLabels = {
  selectedTitle: "Selected Google Drive files",
  chooseAction: "Choose Drive files",
  openingAction: "Opening Drive...",
  description: "Pick only the Google Docs, Sheets, or Slides that Corgtex should sync into this workspace Brain.",
  syncQueued: "Google Drive document sync is queued.",
  missingConfig: "Missing public Picker config",
  syncError: "Could not sync selected Google Drive files.",
  openError: "Could not open Google Drive Picker.",
};

function loadScript(id: string, src: string) {
  return new Promise<void>((resolve, reject) => {
    if (document.getElementById(id)) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

function loadPickerApi() {
  return new Promise<void>((resolve, reject) => {
    if (!window.gapi) {
      reject(new Error("Google Picker API is unavailable."));
      return;
    }
    window.gapi.load("picker", resolve);
  });
}

function requestDriveToken(clientId: string) {
  return new Promise<string>((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) {
      reject(new Error("Google Identity Services is unavailable."));
      return;
    }

    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error || "Google Drive authorization failed."));
          return;
        }
        resolve(response.access_token);
      },
    });
    client.requestAccessToken({ prompt: "" });
  });
}

export function GoogleDrivePicker({
  workspaceId,
  clientId,
  developerKey,
  appId,
  initialSelectedIds,
  autoOpen = false,
  onSynced,
  labels,
}: {
  workspaceId: string;
  clientId: string | null;
  developerKey: string | null;
  appId: string | null;
  initialSelectedIds: string[];
  autoOpen?: boolean;
  onSynced?: (count: number) => void;
  labels?: Partial<GoogleDrivePickerLabels>;
}) {
  const autoOpenRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState(initialSelectedIds);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  const missingConfig = useMemo(() => {
    const missing = [];
    if (!clientId) missing.push("Google OAuth client ID");
    if (!developerKey) missing.push("Google Picker API key");
    if (!appId) missing.push("Google Cloud project number");
    return missing;
  }, [appId, clientId, developerKey]);
  const pickerLabels = useMemo(() => ({
    ...DEFAULT_GOOGLE_DRIVE_PICKER_LABELS,
    ...labels,
  }), [labels]);

  const saveSelection = useCallback(async (docs: Array<{ id?: string; name?: string }>) => {
    const documentIds = docs.map((doc) => doc.id).filter((id): id is string => Boolean(id));
    if (documentIds.length === 0) return;

    const response = await fetch(`/api/workspaces/${workspaceId}/onboarding/google-drive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentIds }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error?.message || pickerLabels.syncError);
    }

    setSelectedIds(documentIds);
    setSelectedNames(docs.map((doc) => doc.name).filter((name): name is string => Boolean(name)));
    setStatus(pickerLabels.syncQueued);
    onSynced?.(documentIds.length);
  }, [onSynced, pickerLabels.syncError, pickerLabels.syncQueued, workspaceId]);

  const openPicker = useCallback(async () => {
    if (!clientId || !developerKey || !appId) {
      setError(`${pickerLabels.missingConfig}: ${missingConfig.join(", ")}.`);
      return;
    }

    setIsOpening(true);
    setStatus(null);
    setError(null);
    try {
      await Promise.all([
        loadScript("google-identity-services", "https://accounts.google.com/gsi/client"),
        loadScript("google-api", "https://apis.google.com/js/api.js"),
      ]);
      await loadPickerApi();
      const token = await requestDriveToken(clientId);
      const pickerApi = window.google?.picker;
      if (!pickerApi) {
        throw new Error("Google Picker API is unavailable.");
      }

      const docsView = new pickerApi.DocsView(pickerApi.ViewId.DOCUMENTS ?? pickerApi.ViewId.DOCS)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false);
      const sheetsView = new pickerApi.DocsView(pickerApi.ViewId.SPREADSHEETS ?? pickerApi.ViewId.DOCS)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false);
      const slidesView = new pickerApi.DocsView(pickerApi.ViewId.PRESENTATIONS ?? pickerApi.ViewId.DOCS)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false);

      const picker = new pickerApi.PickerBuilder()
        .setAppId(appId)
        .setDeveloperKey(developerKey)
        .setOAuthToken(token)
        .addView(docsView)
        .addView(sheetsView)
        .addView(slidesView)
        .enableFeature(pickerApi.Feature.MULTISELECT_ENABLED)
        .setCallback((data: any) => {
          if (data.action !== pickerApi.Action.PICKED) return;
          void saveSelection(Array.isArray(data.docs) ? data.docs : []).catch((selectionError) => {
            setError(selectionError instanceof Error ? selectionError.message : pickerLabels.syncError);
          });
        })
        .build();
      picker.setVisible(true);
    } catch (pickerError) {
      setError(pickerError instanceof Error ? pickerError.message : pickerLabels.openError);
    } finally {
      setIsOpening(false);
    }
  }, [appId, clientId, developerKey, missingConfig, pickerLabels.missingConfig, pickerLabels.openError, pickerLabels.syncError, saveSelection]);

  useEffect(() => {
    if (!autoOpen || autoOpenRef.current || missingConfig.length > 0) return;
    autoOpenRef.current = true;
    void openPicker();
  }, [autoOpen, missingConfig.length, openPicker]);

  return (
    <div className="nr-item stack" style={{ gap: 8, padding: 12, marginTop: 8 }}>
      <div className="row">
        <strong className="nr-item-title" style={{ fontSize: "0.95rem" }}>{pickerLabels.selectedTitle}</strong>
        <button type="button" className="button secondary small" onClick={openPicker} disabled={isOpening || missingConfig.length > 0}>
          {isOpening ? pickerLabels.openingAction : pickerLabels.chooseAction}
        </button>
      </div>
      <p className="nr-item-meta" style={{ fontSize: "0.78rem", margin: 0 }}>
        {pickerLabels.description}
      </p>
      {missingConfig.length > 0 && (
        <p className="form-message form-message-error">
          {pickerLabels.missingConfig}: {missingConfig.join(", ")}.
        </p>
      )}
      {error && <p className="form-message form-message-error">{error}</p>}
      {status && <p className="form-message form-message-success">{status}</p>}
      {(selectedNames.length > 0 || selectedIds.length > 0) && (
        <ul className="nr-item-meta" style={{ fontSize: "0.78rem", margin: 0, paddingLeft: 18 }}>
          {(selectedNames.length > 0 ? selectedNames : selectedIds).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
