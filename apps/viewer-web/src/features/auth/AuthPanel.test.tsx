import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthPanel } from "./AuthPanel";
import { requestMagicLink } from "./auth";

vi.mock("./auth", () => ({
  requestMagicLink: vi.fn()
}));

const mockedRequest = vi.mocked(requestMagicLink);

describe("AuthPanel", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it("sends a sign-in link and shows the check-inbox state", async () => {
    mockedRequest.mockResolvedValue({});
    render(<AuthPanel user={null} onSignOut={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Display name (first sign-in)"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));

    await waitFor(() =>
      expect(screen.getByText(/Check your inbox for a sign-in link/)).toBeInTheDocument()
    );
    expect(mockedRequest).toHaveBeenCalledWith({ email: "ada@example.com", displayName: "Ada" });
  });

  it("shows the verified account and signs out", async () => {
    const onSignOut = vi.fn();
    render(
      <AuthPanel
        user={{
          id: "user-1",
          email: "ada@example.com",
          displayName: "Ada",
          createdAt: "2026-10-24T00:00:00.000Z"
        }}
        onSignOut={onSignOut}
      />
    );

    expect(screen.getByText("Verified creator")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
