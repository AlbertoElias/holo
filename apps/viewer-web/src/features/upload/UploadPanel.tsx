import { useId, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import type { HologramDTO, UserDTO } from "@holoim/contracts";
import { glyphAppearance, glyphDrawing } from "@holoim/xr-ui-core";
import { GlyphControl, GlyphSvg, Type } from "@holoim/ui-dom";

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
  /** Uploads are credited to the signed-in account; the sheet shows sign-in until there is one. */
  currentUser: UserDTO;
  /**
   * An upload is in flight that this panel did not start: the sheet closed over it and opened again onto a new
   * panel, which has no memory of it. The feed owns the status, so it says so. (B-057)
   */
  uploadInFlight?: boolean;
};

const UPLOAD_DRAWING = glyphDrawing("upload");
const DROP_APPEARANCE = glyphAppearance({}, { headset: false });

export function UploadPanel({ onUploaded, onStatus, currentUser, uploadInFlight = false }: UploadPanelProps) {
  const formId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ownUpload, setOwnUpload] = useState(false);
  // One upload at a time, whichever panel started it.
  const isUploading = ownUpload || uploadInFlight;
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [hologramName, setHologramName] = useState("");
  const [quickLookEnabled, setQuickLookEnabled] = useState(false);
  const [dragging, setDragging] = useState(false);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    chooseFile(event.target.files?.[0]);
  }

  async function submit() {
    if (isUploading) return;
    if (!selectedFile) {
      onStatus?.({ kind: "error", message: "Choose a GLB file first." });
      return;
    }

    const trimmedName = hologramName.trim();
    if (!trimmedName) {
      onStatus?.({ kind: "error", message: "A hologram name is needed." });
      return;
    }

    setOwnUpload(true);
    onStatus?.({ kind: "uploading", name: trimmedName });
    try {
      const uploaded = await uploadHologram({
        file: selectedFile,
        hologramName: trimmedName,
        submittedBy: currentUser.displayName,
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
      setOwnUpload(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function chooseFile(file: File | undefined) {
    onStatus?.(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    if (!hologramName.trim()) {
      setHologramName(file.name.replace(/\.glb$/i, ""));
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (!file || isUploading) return;
    // The input holds the dropped file too, so the form reads one source.
    if (fileInputRef.current) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInputRef.current.files = transfer.files;
    }
    chooseFile(file);
  }

  return (
    <form id={formId} className="upload-form" onSubmit={onSubmit}>
      <label
        className="upload-drop"
        htmlFor="glb-upload"
        data-dragging={dragging ? "" : undefined}
        data-chosen={selectedFile ? "" : undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          ref={fileInputRef}
          id="glb-upload"
          className="visually-hidden"
          type="file"
          accept=".glb,model/gltf-binary"
          onChange={onFileChange}
          disabled={isUploading}
        />
        <GlyphSvg drawing={UPLOAD_DRAWING} appearance={DROP_APPEARANCE} />
        {selectedFile ? (
          <>
            <Type variant="captionUnderCard" className="upload-drop-name">{selectedFile.name}</Type>
            <Type variant="byline">{`${formatMegabytes(selectedFile.size)} · choose another`}</Type>
          </>
        ) : (
          <>
            <Type variant="captionUnderCard">Choose a GLB file</Type>
            <Type variant="byline">or drop it here · up to 100 MB</Type>
          </>
        )}
      </label>
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
      <Type variant="byline" as="p">{`Credited to ${currentUser.displayName}, your verified account name.`}</Type>
      <div className="upload-quicklook">
        <label htmlFor="quicklook-enabled" className="upload-quicklook-toggle">
          <Type variant="captionUnderCard">iOS Quick Look</Type>
          <input
            id="quicklook-enabled"
            className="upload-switch"
            type="checkbox"
            role="switch"
            checked={quickLookEnabled}
            onChange={(event) => {
              onStatus?.(null);
              setQuickLookEnabled(event.target.checked);
            }}
            disabled={isUploading}
          />
        </label>
        <Type variant="byline" as="p">
          Converts the GLB to USDZ on upload so iPhone and iPad can open this hologram in Quick Look.
          Leave off except for demos.
        </Type>
      </div>
      <div className="upload-actions">
        {/* With no file chosen, a press says so on the chip rather than doing nothing. */}
        <GlyphControl
          glyph="upload"
          showLabel
          label={VIEWER_CONTROL_NAMES.submitUpload}
          word={isUploading ? "Uploading…" : VIEWER_CONTROL_NAMES.submitUpload}
          onPress={() => void submit()}
        />
      </div>
    </form>
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}
