import type { ProfileUpdate } from "@kuutti/schema";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { saveSession } from "@/lib/session";
import { changesOf, EMPTY_PROFILE, useProfile, withChanges } from "./useProfile";

// The profile as a draft (#47): what the API stored, what is typed since, the
// save that trims and leaves unanswered prompts out, and what a failed read or
// save leaves on screen.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

const DOCUMENT: ProfileUpdate = {
  displayName: "Aino",
  bio: "Long walks.",
  bioPreset: null,
  fields: { intent: "long_term", height: 170 },
  prompts: [{ key: "sunday", answer: "A long breakfast." }],
};
const stored = (document: ProfileUpdate | null) => ({
  profile: document
    ? { ...document, specialCategoryConsent: null, updatedAt: "2026-09-26T10:00:00.000Z" }
    : null,
  completeness: { complete: false, missing: ["photos"] },
});

type Answer = Response | Promise<Response>;
/** GET /profile and PUT /profile, answered in turn; the PUT bodies are kept. */
function serve(reads: Array<() => Answer>, saves: Array<(body: unknown) => Answer> = []) {
  const saved: unknown[] = [];
  let r = 0;
  let s = 0;
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "GET") {
      const read = reads[Math.min(r, reads.length - 1)];
      r += 1;
      if (!read) throw new Error("no read prepared");
      return read();
    }
    const body = await request.json();
    saved.push(body);
    const save = saves[Math.min(s, saves.length - 1)];
    s += 1;
    if (!save) throw new Error("no save prepared");
    return save(body);
  }) as unknown as typeof fetch;
  return saved;
}

async function ready() {
  const view = await renderHook(() => useProfile());
  await waitFor(() => expect(view.result.current.status).not.toBe("loading"));
  return view;
}

beforeEach(async () => {
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("useProfile: reading", () => {
  it("loads the stored document as the draft, with what is missing", async () => {
    serve([() => json(stored(DOCUMENT))]);
    const { result } = await ready();
    expect(result.current.status).toBe("ready");
    expect(result.current.draft).toEqual(DOCUMENT);
    expect(result.current.saved).toEqual(DOCUMENT);
    expect(result.current.completeness).toEqual({ complete: false, missing: ["photos"] });
    expect(result.current.dirty).toBe(false);
  });

  it("starts from an empty document before the first save", async () => {
    serve([() => json(stored(null))]);
    const { result } = await ready();
    expect(result.current.draft).toEqual(EMPTY_PROFILE);
    expect(result.current.dirty).toBe(false);
  });

  it("is an error when the first read fails", async () => {
    serve([() => refusal("internal_error", 500)]);
    const { result } = await ready();
    expect(result.current.status).toBe("error");
  });

  it("keeps what it showed when a read again fails, and takes a read again that succeeds", async () => {
    const reads = [
      () => json(stored(DOCUMENT)),
      () => refusal("internal_error", 500),
      () => json(stored({ ...DOCUMENT, displayName: "Aino K." })),
    ];
    serve(reads);
    const { result } = await ready();
    await act(async () => result.current.reload());
    expect(result.current.status).toBe("ready");
    expect(result.current.draft.displayName).toBe("Aino");
    await act(async () => result.current.reload());
    expect(result.current.draft.displayName).toBe("Aino K.");
  });
});

describe("useProfile: editing and saving", () => {
  it("is dirty after an edit, and not for the same document with its keys in another order", async () => {
    serve([() => json(stored(DOCUMENT))]);
    const { result } = await ready();
    await act(async () =>
      result.current.update({
        fields: { height: 170, intent: "long_term" },
        prompts: [...DOCUMENT.prompts],
      }),
    );
    expect(result.current.dirty).toBe(false);
    await act(async () => result.current.update({ displayName: "Aino K." }));
    expect(result.current.dirty).toBe(true);
  });

  it("saves the name and bio trimmed, a blank bio as none, and only the answered prompts", async () => {
    const saved = serve(
      [() => json(stored(DOCUMENT))],
      [() => json(stored({ ...DOCUMENT, displayName: "Aino", bio: null, prompts: [] }))],
    );
    const { result } = await ready();
    await act(async () =>
      result.current.update({
        displayName: "  Aino  ",
        bio: "   ",
        prompts: [
          { key: "sunday", answer: "  " },
          { key: "hidden_talent", answer: " Whistling. " },
        ],
      }),
    );
    let refusal: unknown;
    await act(async () => {
      refusal = await result.current.save();
    });
    expect(refusal).toBeNull();
    expect(saved[0]).toMatchObject({
      displayName: "Aino",
      bio: null,
      prompts: [{ key: "hidden_talent", answer: "Whistling." }],
    });
    // The stored document replaces the draft: nothing left to lose.
    expect(result.current.draft).toMatchObject({ bio: null, prompts: [] });
    expect(result.current.dirty).toBe(false);
    expect(result.current.saving).toBe(false);
  });

  it("keeps what was typed while the save was in flight", async () => {
    let answer: ((response: Response) => void) | undefined;
    serve(
      [() => json(stored(DOCUMENT))],
      [
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ],
    );
    const { result } = await ready();
    await act(async () => result.current.update({ displayName: "Aino K" }));
    let saving: Promise<unknown> | undefined;
    await act(async () => {
      saving = result.current.save();
    });
    expect(result.current.saving).toBe(true);
    await act(async () => result.current.update({ displayName: "Aino Ka" }));
    await act(async () => {
      answer?.(json(stored({ ...DOCUMENT, displayName: "Aino K" })));
      await saving;
    });
    expect(result.current.draft.displayName).toBe("Aino Ka");
    expect(result.current.saved.displayName).toBe("Aino K");
    expect(result.current.dirty).toBe(true);
  });

  it("saves what its draft changed onto the document as stored, so two drafts read together both keep theirs (#238)", async () => {
    // One stored document, as the API keeps it: a save replaces it whole.
    let document: ProfileUpdate = DOCUMENT;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "PUT") document = (await request.json()) as ProfileUpdate;
      return json(stored(document));
    }) as unknown as typeof fetch;
    const name = await ready();
    const height = await ready();
    await act(async () => name.result.current.update({ displayName: "Aino K" }));
    await act(async () =>
      height.result.current.update({ fields: { ...DOCUMENT.fields, height: 180 } }),
    );
    await act(async () => {
      await name.result.current.save();
    });
    await act(async () => {
      await height.result.current.save();
    });
    expect(document).toEqual({
      ...DOCUMENT,
      displayName: "Aino K",
      fields: { intent: "long_term", height: 180 },
    });
    // Each draft is the stored document after its save: nothing of the other is undone on screen.
    expect(height.result.current.draft).toEqual(document);
    expect(height.result.current.dirty).toBe(false);
  });

  it("keeps the draft when the API answers a save without a document", async () => {
    serve([() => json(stored(DOCUMENT))], [() => json(stored(null))]);
    const { result } = await ready();
    await act(async () => result.current.update({ displayName: "Aino K." }));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.draft.displayName).toBe("Aino K.");
    expect(result.current.saved.displayName).toBe("Aino");
  });

  it("answers and says why when the save is refused, and clears that on the next edit", async () => {
    serve([() => json(stored(DOCUMENT))], [() => refusal("validation_failed", 422)]);
    const { result } = await ready();
    let answer: unknown;
    await act(async () => {
      answer = await result.current.save();
    });
    expect(answer).toEqual({ kind: "error", code: "validation_failed" });
    expect(result.current.notice).toEqual({ kind: "error", code: "validation_failed" });
    expect(result.current.saving).toBe(false);
    await act(async () => result.current.update({ displayName: "Aino K." }));
    expect(result.current.notice).toBeNull();
  });

  it("says the save failed without a code when the network fails", async () => {
    serve(
      [() => json(stored(DOCUMENT))],
      [
        () => {
          throw new TypeError("Network request failed");
        },
      ],
    );
    const { result } = await ready();
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.notice).toEqual({ kind: "error", code: undefined });
  });
});

describe("useProfile: a section that has gone (#238)", () => {
  it("puts held changes back over the stored document, with the reason, on the first read only", async () => {
    // Saved by another section since the changes were refused: kept under them (#238).
    serve([() => json(stored({ ...DOCUMENT, displayName: "Aino K" }))]);
    const held = {
      changes: { bio: "Call me on 040 123 4567.", bioPreset: null },
      notice: { kind: "error", code: "text_contact_details" } as const,
    };
    const view = await renderHook(() => useProfile(held));
    await waitFor(() => expect(view.result.current.status).toBe("ready"));
    expect(view.result.current.draft).toEqual({
      ...DOCUMENT,
      displayName: "Aino K",
      bio: "Call me on 040 123 4567.",
    });
    expect(view.result.current.saved.bio).toBe("Long walks.");
    expect(view.result.current.changes).toEqual(held.changes);
    expect(view.result.current.dirty).toBe(true);
    expect(view.result.current.notice).toEqual(held.notice);
    await act(async () => {
      await view.result.current.reload();
    });
    expect(view.result.current.draft.bio).toBe("Long walks.");
  });

  it("answers a refusal to a screen that has already gone", async () => {
    let answer: ((response: Response) => void) | undefined;
    serve(
      [() => json(stored(DOCUMENT))],
      [
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ],
    );
    const { result, unmount } = await ready();
    await act(async () => result.current.update({ bio: "aino@example.com" }));
    let saving: Promise<unknown> | undefined;
    await act(async () => {
      saving = result.current.save();
    });
    await act(async () => unmount());
    answer?.(refusal("text_contact_details", 400));
    expect(await saving).toEqual({ kind: "error", code: "text_contact_details" });
  });

  it("answers null to a screen that has already gone when the save is taken", async () => {
    let answer: ((response: Response) => void) | undefined;
    serve(
      [() => json(stored(DOCUMENT))],
      [
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ],
    );
    const { result, unmount } = await ready();
    await act(async () => result.current.update({ displayName: "Aino K" }));
    let saving: Promise<unknown> | undefined;
    await act(async () => {
      saving = result.current.save();
    });
    await act(async () => unmount());
    answer?.(json(stored({ ...DOCUMENT, displayName: "Aino K" })));
    expect(await saving).toBeNull();
  });
});

describe("changesOf and withChanges: what a draft changed, put on another document (#238)", () => {
  it("names nothing for the same document with its keys in another order", () => {
    const reordered = {
      ...DOCUMENT,
      fields: { height: 170, intent: "long_term" },
    } as ProfileUpdate;
    expect(changesOf(DOCUMENT, reordered)).toEqual({});
  });

  it("names the name, the prompts, and each field set, changed or taken away", () => {
    const to = {
      ...DOCUMENT,
      displayName: "Aino K",
      prompts: [],
      fields: { intent: "casual", smoking: "never" },
    } as ProfileUpdate;
    expect(changesOf(DOCUMENT, to)).toEqual({
      displayName: "Aino K",
      prompts: [],
      fields: { intent: "casual", height: undefined, smoking: "never" },
    });
  });

  it("names a bio and a ready line together when either changes: the API takes one, never both", () => {
    expect(changesOf(DOCUMENT, { ...DOCUMENT, bio: null, bioPreset: "photos_speak" })).toEqual({
      bio: null,
      bioPreset: "photos_speak",
    });
    expect(changesOf(DOCUMENT, { ...DOCUMENT, bio: "Short walks." })).toEqual({
      bio: "Short walks.",
      bioPreset: null,
    });
  });

  it("puts the changes on the document and keeps what they do not name, a field taken away gone", () => {
    const document = {
      ...DOCUMENT,
      displayName: "Aino K",
      fields: { intent: "casual", height: 170 },
    };
    expect(
      withChanges(document as ProfileUpdate, {
        bio: null,
        bioPreset: "ask_me_instead",
        fields: { height: undefined, smoking: "never" },
      }),
    ).toEqual({
      ...DOCUMENT,
      displayName: "Aino K",
      bio: null,
      bioPreset: "ask_me_instead",
      fields: { intent: "casual", smoking: "never" },
    });
    expect(withChanges(DOCUMENT, {})).toEqual(DOCUMENT);
  });
});
