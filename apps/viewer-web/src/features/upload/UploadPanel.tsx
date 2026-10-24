import { useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { HologramDTO } from "@holoim/contracts";
import { GlyphControl, Type } from "@holoim/ui-dom";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { uploadHologram } from "../feed/api";

// The upload form, shown in the side sheet (brief Q11). Its status and its
// errors are feed-wide notices, so they go to the chip, never under the form.

export type UploadStatus =
  | { kind: "uploading"; name: string }
  | { kind: "uploaded"; name: string }
  | { kind: "error"; message: string };

type UploadPanelProps = {
  onUploaded: (item: HologramDTO) => void;
  onStatus?: (status: UploadStatus | null) => void;
};

const submittedByStorageKey = "holoim.upload.submittedBy";

export function UploadPanel({ onUploaded, onStatus }: UploadPanelProps) {
  const formId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [hologramName, setHologramName] = useState("");
  const [quickLookEnabled, setQuickLookEnabled] = useState(false);
  const [submittedBy, setSubmittedBy] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return window.localStorage.getItem(submittedByStorageKey) ?? "";
  });

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    onStatus?.(null);
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
    onStatus?.(null);
    setSubmittedBy(value);
    window.localStorage.setItem(submittedByStorageKey, value);
  }

  async function submit() {
    if (isUploading) return;
    if (!selectedFile) {
      onStatus?.({ kind: "error", message: "Choose a GLB file first." });
      return;
    }

    const trimmedName = hologramName.trim();
    const trimmedSubmittedBy = submittedBy.trim();
    if (!trimmedName || !trimmedSubmittedBy) {
      onStatus?.({ kind: "error", message: "A hologram name and who submitted it are both needed." });
      return;
    }

    setIsUploading(true);
    onStatus?.({ kind: "uploading", name: trimmedName });
    try {
      const uploaded = await uploadHologram({
        file: selectedFile,
        hologramName: trimmedName,
        submittedBy: trimmedSubmittedBy,
        quickLookEnabled
      });
      onUploaded(uploaded);
      onStatus?.({ kind: "uploaded", name: uploaded.hologramName });
      setSelectedFile(null);
      setHologramName("");
      setQuickLookEnabled(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (caught) {
      onStatus?.({ kind: "error", message: caught instanceof Error ? caught.message : "Upload failed." });
    } finally {
      setIsUploading(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  return (
    <form id={formId} className="upload-form" onSubmit={onSubmit}>
      <label className="upload-field">
        <Type variant="byline">Hologram name</Type>
        <input
          className="upload-input"
          value={hologramName}
          onChange={(event) => {
            onStatus?.(null);
            setHologramName(event.target.value);
          }}
          maxLength={120}
          disabled={isUploading}
        />
      </label>
      <label className="upload-field">
        <Type variant="byline">Submitted by</Type>
        <input className="upload-input" value={submittedBy} onChange={onSubmittedByChange} maxLength={80} disabled={isUploading} />
      </label>
      <label className="upload-field" htmlFor="glb-upload">
        <Type variant="byline">GLB file, up to 25 MB</Type>
      </label>
      <input
        ref={fileInputRef}
        id="glb-upload"
        className="upload-file"
        type="file"
        accept=".glb,model/gltf-binary"
        onChange={onFileChange}
        disabled={isUploading}
      />
      {selectedFile ? <Type variant="byline" as="p">{`Selected: ${selectedFile.name}`}</Type> : null}
      <label htmlFor="quicklook-enabled" className="upload-quicklook-toggle">
        <input
          id="quicklook-enabled"
          type="checkbox"
          checked={quickLookEnabled}
          onChange={(event) => {
            onStatus?.(null);
            setQuickLookEnabled(event.target.checked);
          }}
          disabled={isUploading}
        />
        <Type variant="captionUnderCard">Enable iOS Quick Look (USDZ)</Type>
      </label>
      <Type variant="byline" as="p">
        Optional. Converts the GLB to USDZ on upload and stores it so iPhone and iPad can open
        this hologram in Quick Look. Leave off except for demos.
      </Type>
      <div className="upload-actions">
        {/* With no file chosen, a press says so on the chip rather than doing nothing. */}
        <GlyphControl
          glyph={null}
          label={VIEWER_CONTROL_NAMES.submitUpload}
          word={isUploading ? "Uploading…" : VIEWER_CONTROL_NAMES.submitUpload}
          onPress={() => void submit()}
        />
      </div>
    </form>
  );
}
