import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshButton } from "./refresh-button.tsx";

afterEach(cleanup);

describe("RefreshButton", () => {
  it("is a button named by its words, with a silent icon, that reads again when pressed", () => {
    const onClick = vi.fn();
    render(<RefreshButton onClick={onClick}>Refresh the queue</RefreshButton>);
    const button = screen.getByRole("button", { name: "Refresh the queue" });
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
