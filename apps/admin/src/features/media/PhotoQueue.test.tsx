import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { PhotoQueue } from "./PhotoQueue.tsx";

// The queue as a moderator uses it (#49): items with what the check saw, the
// card through a signed URL, approve and reject with a reason from the list;
// every request carries the admin token. Requests are answered by a fake
// fetch keyed on method and path.

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  photoId: `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`,
  accountId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  state: "queued",
  blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  width: 800,
  height: 1067,
  uploadedAt: "2026-09-25T12:00:00.000Z",
  checkedAt: "2026-09-25T12:00:02.000Z",
  labels: [{ name: "Suggestive", parentName: "", confidence: 71.4 }],
  faces: 1,
  flagged: ["Suggestive"],
  appealed: false,
  sensitive: false,
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (req: Request) => Promise<Response> | Response | null;
function fetchMock(handlers: Handler[]) {
  const calls: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push(req);
      for (const handler of handlers) {
        const res = await handler(req);
        if (res) return res;
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    }),
  );
  return calls;
}
const path = (req: Request) => new URL(req.url).pathname;
const cardUrls: Handler = (req) =>
  req.method === "GET" && /\/admin\/photos\/[^/]+\/card$/.test(path(req))
    ? json({
        url: "https://media.test/media/k/card.webp?Signature=s",
        variant: "card",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })
    : null;

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <PhotoQueue />
    </I18nProvider>,
  );
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PhotoQueue", () => {
  it("lists queued photos with the card, what the check saw, and labelled controls", async () => {
    const calls = fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/photos/queue"
          ? json({
              items: [item(1), item(2, { labels: [], faces: 0, flagged: ["no_face"] })],
              total: 2,
            })
          : null,
      cardUrls,
    ]);
    show();
    expect(await screen.findByText("2 photos waiting")).toBeInTheDocument();
    expect(await screen.findAllByRole("img", { name: "Photo under review" })).toHaveLength(2);
    expect(screen.getByText("Suggestive (71 %)")).toBeInTheDocument();
    expect(screen.getByText("No face found")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Reject…" })).toHaveLength(2);
    // Every request carried the admin token; the card was asked for through the API, never the bucket.
    for (const call of calls)
      expect(call.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
    expect(calls.filter((c) => /\/card$/.test(path(c)))).toHaveLength(2);
  });

  it("approves with one click and reports it", async () => {
    const calls = fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/photos/queue"
          ? json({ items: [item(1)], total: 1 })
          : null,
      cardUrls,
      (req) =>
        req.method === "POST" && path(req) === `/admin/photos/${item(1).photoId}/decision`
          ? json({ photoId: item(1).photoId, state: "approved", rejectionReason: null })
          : null,
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Nothing waiting")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(await (post as Request).text())).toEqual({ decision: "approve" });
  });

  it("rejects only after a reason is chosen and confirmed", async () => {
    const calls = fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/photos/queue"
          ? json({ items: [item(1)], total: 1 })
          : null,
      cardUrls,
      (req) =>
        req.method === "POST"
          ? json({ photoId: item(1).photoId, state: "rejected", rejectionReason: "no_person" })
          : null,
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    const select = screen.getByLabelText("Reason the person is told");
    // No reason is preset (#250): the form starts empty and cannot be sent so.
    expect((select as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Reject photo" })).toBeDisabled();
    fireEvent.submit(select.closest("form") as HTMLFormElement);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(select, { target: { value: "no_person" } });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reject photo" }));
    expect(await screen.findByText("Rejected")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(await (post as Request).text())).toEqual({
      decision: "reject",
      reason: "no_person",
    });
  });

  it("cancelling the rejection form changes nothing", async () => {
    const calls = fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/photos/queue"
          ? json({ items: [item(1)], total: 1 })
          : null,
      cardUrls,
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("says when a decision was not saved and when the queue cannot load", async () => {
    fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/photos/queue"
          ? json({ items: [item(1)], total: 1 })
          : null,
      cardUrls,
      (req) =>
        req.method === "POST"
          ? json({ error: { code: "admin_forbidden", message: "x", requestId: "r" } }, 403)
          : null,
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The decision was not saved");
    cleanup();
    vi.unstubAllGlobals();
    fetchMock([
      (req) =>
        path(req) === "/admin/photos/queue"
          ? json({ error: { code: "unauthenticated", message: "x", requestId: "r" } }, 401)
          : null,
    ]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("The queue could not be loaded.");
    cleanup();
    vi.unstubAllGlobals();
    // A network failure rejects the request outright: still the error state, not loading forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("The queue could not be loaded.");
  });

  it("says a decision was not saved when the network fails, and lets the moderator try again", async () => {
    let attempts = 0;
    fetchMock([
      (req) => (path(req) === "/admin/photos/queue" ? json({ items: [item(1)], total: 1 }) : null),
      cardUrls,
      (req) => {
        if (req.method !== "POST") return null;
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return json({ photoId: item(1).photoId, state: "approved", rejectionReason: null });
      },
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The decision was not saved");
    // Not stuck saving: both buttons are back.
    expect(screen.getByRole("button", { name: "Reject…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("shows an unchecked photo as such", async () => {
    fetchMock([
      (req) =>
        path(req) === "/admin/photos/queue"
          ? json({
              items: [item(1, { labels: [], faces: 0, flagged: ["not_checked"], checkedAt: null })],
              total: 1,
            })
          : null,
      cardUrls,
    ]);
    show();
    expect(await screen.findByText("Not checked automatically.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("No face found")).toBeNull());
  });

  it("refreshes on request, loading the queue again and showing what waits now", async () => {
    let total = 2;
    const calls = fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/photos/queue"
          ? json({ items: total > 1 ? [item(1), item(2)] : [item(3)], total })
          : null,
      cardUrls,
    ]);
    show();
    expect(await screen.findByText("2 photos waiting")).toBeInTheDocument();
    total = 1;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("1 photo waiting")).toBeInTheDocument();
    expect(calls.filter((c) => path(c) === "/admin/photos/queue")).toHaveLength(2);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("limit")).toBe("20");
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1));
  });

  it("keeps saying the photo is loading when its signed URL is refused or cannot be fetched, and never shows a broken image", async () => {
    fetchMock([
      (req) => (path(req) === "/admin/photos/queue" ? json({ items: [item(1)], total: 1 }) : null),
      (req) =>
        /\/card$/.test(path(req))
          ? json({ error: { code: "not_found", message: "x", requestId: "r" } }, 404)
          : null,
    ]);
    show();
    const loading = await screen.findByText("Loading the photo…");
    expect(loading).toHaveAttribute("aria-busy", "true");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Loading the photo…")).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    // A network failure rejects the request outright: still loading, and no
    // unhandled rejection, which Vitest would fail the run on.
    const calls = fetchMock([
      (req) => (path(req) === "/admin/photos/queue" ? json({ items: [item(1)], total: 1 }) : null),
      (req) => {
        if (/\/card$/.test(path(req))) throw new TypeError("Failed to fetch");
        return null;
      },
    ]);
    show();
    expect(await screen.findByText("Loading the photo…")).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => /\/card$/.test(path(c)))).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Loading the photo…")).toBeInTheDocument();
  });

  it("cancels the photo's request when the item goes away before the answer", async () => {
    // Without the cancel, a request still on its way when a test ends reached
    // the real fetch once the stub was gone (main's CI on ec116d3).
    let card: Request | undefined;
    fetchMock([
      (req) => (path(req) === "/admin/photos/queue" ? json({ items: [item(1)], total: 1 }) : null),
      (req) => {
        if (!/\/card$/.test(path(req))) return null;
        card = req;
        return new Promise<Response>(() => {});
      },
    ]);
    show();
    await waitFor(() => expect(card).toBeDefined());
    expect(card?.signal.aborted).toBe(false);
    cleanup();
    expect(card?.signal.aborted).toBe(true);
  });

  it("says the check found no moderation label when a face was found and nothing else", async () => {
    fetchMock([
      (req) =>
        path(req) === "/admin/photos/queue"
          ? json({ items: [item(1, { labels: [], faces: 2, flagged: ["several"] })], total: 1 })
          : null,
      cardUrls,
    ]);
    show();
    expect(await screen.findByText("2 faces found")).toBeInTheDocument();
    expect(screen.getByText("The automatic check found no moderation label.")).toBeInTheDocument();
    // The owner is named by the first part of the pseudonymous id only.
    expect(screen.getByText(/Account 6f1c1c4e$/)).toBeInTheDocument();
  });

  it("offers every rejection reason, and holds both buttons while a decision is saving", async () => {
    let answer: ((response: Response) => void) | undefined;
    fetchMock([
      (req) => (path(req) === "/admin/photos/queue" ? json({ items: [item(1)], total: 1 }) : null),
      cardUrls,
      (req) =>
        req.method === "POST"
          ? new Promise<Response>((resolve) => {
              answer = resolve;
            })
          : null,
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    expect(
      screen.getAllByRole("option").map((option) => (option as HTMLOptionElement).value),
    ).toEqual([
      // The empty first choice: no reason until one is chosen (#250).
      "",
      "nudity",
      "no_person",
      "several_people",
      "minor",
      "violence",
      "contact_details",
      "other",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Reject…" })).toBeDisabled();
    answer?.(json({ photoId: item(1).photoId, state: "approved", rejectionReason: null }));
    expect(await screen.findByText("Approved")).toBeInTheDocument();
  });

  it("a decision that lands during a refresh does not take one off the fresh count", async () => {
    let answerDecision: ((response: Response) => void) | undefined;
    let answerQueue: ((response: Response) => void) | undefined;
    let queueLoads = 0;
    fetchMock([
      (req) => {
        if (path(req) !== "/admin/photos/queue") return null;
        queueLoads += 1;
        if (queueLoads === 1) return json({ items: [item(1)], total: 1 });
        return new Promise<Response>((resolve) => {
          answerQueue = resolve;
        });
      },
      cardUrls,
      (req) =>
        req.method === "POST"
          ? new Promise<Response>((resolve) => {
              answerDecision = resolve;
            })
          : null,
    ]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(answerDecision).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Loading the queue…")).toBeInTheDocument();
    answerDecision?.(json({ photoId: item(1).photoId, state: "approved", rejectionReason: null }));
    await waitFor(() => expect(answerQueue).toBeDefined());
    answerQueue?.(json({ items: [item(2)], total: 1 }));
    expect(await screen.findByText("1 photo waiting")).toBeInTheDocument();
    expect(screen.queryByText("Nothing waiting")).toBeNull();
  });

  it("hides a sensitive picture until the moderator chooses to look, and fetches it only then (#253)", async () => {
    const calls = fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/photos/queue"
          ? json({ items: [item(1, { sensitive: true })], total: 1 })
          : null,
      cardUrls,
    ]);
    show();
    expect(
      await screen.findByText(
        "Hidden until you choose to look. The check saw something sensitive.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    // No signed URL, so no audit row of a view that did not happen.
    expect(calls.filter((req) => path(req).endsWith("/card"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show the picture" }));
    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(calls.filter((req) => path(req).endsWith("/card"))).toHaveLength(1);
  });

  it("says when the owner asked a person to look", async () => {
    fetchMock([
      (req) =>
        req.method === "GET" && path(req) === "/admin/photos/queue"
          ? json({ items: [item(1, { appealed: true })], total: 1 })
          : null,
      cardUrls,
    ]);
    show();
    expect(
      await screen.findByText("The owner asked a person to look at the automatic rejection."),
    ).toBeInTheDocument();
  });
});
