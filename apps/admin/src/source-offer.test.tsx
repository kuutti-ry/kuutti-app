import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "./i18n.ts";
import { SourceOffer } from "./source-offer.tsx";

// The footer's source-code offer (AGPL-3.0 section 13, #16): what the running
// API names in /health, and nothing when it cannot be asked.

const health = {
  status: "ok",
  version: "0.0.0-test",
  commit: "abc1234",
  builtAt: "2026-09-13T00:00:00.000Z",
  source: "https://codeberg.org/example/kuutti-fork",
  db: "ok",
  migrations: "current",
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function show() {
  return render(
    <I18nProvider i18n={i18n}>
      <SourceOffer />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourceOffer", () => {
  it("is a busy, empty footer while the API has not answered", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    show();
    // ...and never says the API is unreachable while it is merely slow.
    expect(screen.queryByText(/The API cannot be reached/)).toBeNull();
    const footer = screen.getByRole("contentinfo");
    expect(footer).toHaveAttribute("aria-busy", "true");
    expect(footer).toBeEmptyDOMElement();
  });

  it("asks the API's /health and links the source it names, opening outside the panel", async () => {
    const fetch = vi.fn(async () => json(health));
    vi.stubGlobal("fetch", fetch);
    show();
    const link = await screen.findByRole("link", { name: health.source });
    expect(link).toHaveAttribute("href", health.source);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("runs commit abc1234");
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/health", expect.anything());
  });

  it("says the source is unknown when the request fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    show();
    expect(await screen.findByText(/The API cannot be reached/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says the source is unknown when the answer is not the health contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ status: "ok" })),
    );
    show();
    expect(await screen.findByText(/The API cannot be reached/)).toBeInTheDocument();
  });

  it("cancels the request when the footer goes away", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const { unmount } = show();
    expect(signal?.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });
});
