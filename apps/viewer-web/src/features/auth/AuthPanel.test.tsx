import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("shows the signed-in account and signs out", async () => {
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

    expect(screen.queryByText("Verified creator")).not.toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
