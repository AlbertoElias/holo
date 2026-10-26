import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { HologramDTO, UserDTO } from "@holoim/contracts";
import { UiButton, UiField, UiInput, UiNotice, UiPanel, UiStack } from "@holoim/ui-dom";

import { uploadHologram } from "../feed/api";

type UploadPanelProps = {
  onUploaded: (item: HologramDTO) => void;
  currentUser?: UserDTO | null;
};

const submittedByStorageKey = "holoim.upload.submittedBy";

export function UploadPanel({ onUploaded, currentUser = null }: UploadPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [hologramName, setHologramName] = useState("");
  const [quickLookEnabled, setQuickLookEnabled] = useState(false);
  const [isExpanded, setIsExpanded] = useState(() => {
    // Start expanded on desktop (where toggle is hidden), collapsed on mobile
    if (typeof window === "undefined") {
      return true;
    }
    return window.innerWidth > 768;
  });
  const [submittedBy, setSubmittedBy] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return window.localStorage.getItem(submittedByStorageKey) ?? "";
  });

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = event.target.files?.[0];
    if (!file) {
      setSelectedFile(null);
      return;
    }

    setSelectedFile(file);
    if (!hologramName.trim()) {
      setHologramName(file.name.replace(/\.glb$/i, ""));
    }
  }

  function onSubmittedByChange(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setError(null);
    setSubmittedBy(value);
    window.localStorage.setItem(submittedByStorageKey, value);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) {
      setError("Please choose a GLB file first.");
      return;
    }

    const trimmedName = hologramName.trim();
    const trimmedSubmittedBy = currentUser?.displayName ?? submittedBy.trim();
    if (!trimmedName || !trimmedSubmittedBy) {
      setError("Hologram name and submitted by are required.");
      return;
    }

    setIsUploading(true);
    setError(null);
    try {
      const uploaded = await uploadHologram({
        file: selectedFile,
        hologramName: trimmedName,
        submittedBy: trimmedSubmittedBy,
        quickLookEnabled
      });
      onUploaded(uploaded);
      setSelectedFile(null);
      setHologramName("");
      setQuickLookEnabled(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section className={`upload-panel ${isExpanded ? "upload-panel-expanded" : ""}`}>
      <UiButton
        type="button"
        className="upload-toggle"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-label={isExpanded ? "Collapse upload panel" : "Expand upload panel"}
        tone="ghost"
        style={{ width: "100%" }}
      >
        {isExpanded ? "✕" : "⬆ Upload"}
      </UiButton>
      {isExpanded && (
        <UiPanel style={{ padding: "0.95rem", marginTop: "0.6rem" }}>
          <form onSubmit={onSubmit}>
            <UiStack gap="0.65rem">
              <label htmlFor="glb-upload" className="upload-title">
                Upload Hologram
              </label>
              <UiField label="Hologram name">
                <UiInput
                  value={hologramName}
                  onChange={(event) => {
                    setError(null);
                    setHologramName(event.target.value);
                  }}
                  maxLength={120}
                  disabled={isUploading}
                />
              </UiField>
              <UiField label="Submitted by">
                <UiInput
                  value={currentUser ? currentUser.displayName : submittedBy}
                  onChange={onSubmittedByChange}
                  maxLength={80}
                  disabled={isUploading || Boolean(currentUser)}
                />
              </UiField>
              {currentUser ? <p className="upload-caption">Uploads are credited to your verified account name.</p> : null}
              <input
                ref={fileInputRef}
                id="glb-upload"
                type="file"
                accept=".glb,model/gltf-binary"
                onChange={onFileChange}
                disabled={isUploading}
              />
              <p className="upload-caption">
                {selectedFile ? `Selected: ${selectedFile.name}` : "GLB only, up to 25MB"}
              </p>
              <label htmlFor="quicklook-enabled" className="upload-quicklook-toggle">
                <input
                  id="quicklook-enabled"
                  type="checkbox"
                  checked={quickLookEnabled}
                  onChange={(event) => {
                    setError(null);
                    setQuickLookEnabled(event.target.checked);
                  }}
                  disabled={isUploading}
                />
                <span>Enable iOS Quick Look (USDZ)</span>
              </label>
              <p className="upload-caption">
                Optional. Converts the GLB to USDZ on upload and stores it so iPhone and iPad can open
                this hologram in Quick Look. Leave off except for demos.
              </p>
              <UiButton type="submit" disabled={isUploading || !selectedFile}>
                {isUploading ? "Uploading..." : "Upload"}
              </UiButton>
              {error ? <UiNotice tone="danger">{error}</UiNotice> : null}
            </UiStack>
          </form>
        </UiPanel>
      )}
    </section>
  );
}
