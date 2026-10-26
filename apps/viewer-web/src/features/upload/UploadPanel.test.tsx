import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HologramDTO } from "@holoim/contracts";

import { uploadHologram } from "../feed/api";
import { UploadPanel } from "./UploadPanel";

vi.mock("../feed/api", () => ({
  uploadHologram: vi.fn()
}));

const mockedUpload = vi.mocked(uploadHologram);

function fakeDto(quickLookEnabled: boolean): HologramDTO {
  return {
    id: "holo-1",
    url: "/uploads/avatar.glb",
    usdzUrl: null,
    usdzStatus: "none",
    quickLookEnabled,
    createdAt: "2026-02-10T00:00:00.000Z",
    sizeBytes: 12,
    filenameOriginal: "avatar.glb",
    hologramName: "Demo",
    submittedBy: "Tester",
    submittedByVerified: false,
    ownedByViewer: false
  };
}

async function fillAndSelectFile(container: HTMLElement) {
  fireEvent.change(screen.getByLabelText("Hologram name"), { target: { value: "Demo" } });
  fireEvent.change(screen.getByLabelText("Submitted by"), { target: { value: "Tester" } });
  const fileInput = container.querySelector<HTMLInputElement>("#glb-upload");
  expect(fileInput).not.toBeNull();
  fireEvent.change(fileInput!, {
    target: { files: [new File(["glb"], "avatar.glb", { type: "model/gltf-binary" })] }
  });
}

describe("UploadPanel Quick Look opt-in", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockedUpload.mockReset();
    window.localStorage.clear();
  });

  it("is unchecked by default and uploads with Quick Look disabled", async () => {
    mockedUpload.mockResolvedValue(fakeDto(false));
    const onUploaded = vi.fn();
    const { container } = render(<UploadPanel onUploaded={onUploaded} />);

    const checkbox = screen.getByLabelText("iOS Quick Look") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await fillAndSelectFile(container);
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    expect(mockedUpload).toHaveBeenCalledWith(expect.objectContaining({ quickLookEnabled: false }));
  });

  it("uploads with Quick Look enabled when checked and resets to unchecked after upload", async () => {
    mockedUpload.mockResolvedValue(fakeDto(true));
    const onUploaded = vi.fn();
    const { container } = render(<UploadPanel onUploaded={onUploaded} />);

    const checkbox = screen.getByLabelText("iOS Quick Look") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    await fillAndSelectFile(container);
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    expect(mockedUpload).toHaveBeenCalledWith(expect.objectContaining({ quickLookEnabled: true }));
    expect(checkbox.checked).toBe(false);
  });
});
