import { formatDateTime } from "@kuutti/i18n";
import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { AccountLookup, AccountPage } from "./AccountPage.tsx";

// A person's page as a moderator uses it (#306): the way in by an account id
// only, then every section of the page from the API's answer, the sanctions
// from their own route (#307), and a photo fetched only when asked (#253).
// Requests are answered by a fake fetch keyed on method and path.

const ID = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const STAFF = "a1b2c3d4-9a8e-4a0b-9c3a-0c8d1e2f3a99";
const photoId = (n: number) =>
  `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`;
const sanctionId = (n: number) =>
  `5a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`;

const CHANGED = "2026-10-10T09:00:00.000Z";
const REGISTERED = "2026-09-01T08:00:00.000Z";
const UNTIL = "2026-10-31T22:00:00.000Z";
const UPLOADED = "2026-09-02T10:15:00.000Z";
const SENT = "2026-10-05T14:30:00.000Z";
const HANDLED = "2026-10-06T07:45:00.000Z";
const LOOKED = "2026-10-15T12:00:00.000Z";
const LIFTED = "2026-10-12T16:20:00.000Z";
const when = (at: string) => formatDateTime("en", new Date(at));

/** A full answer: every section with something in it, both sides of every optional value. */
const page = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  state: "suspended",
  stateChangedAt: CHANGED,
  registeredAt: REGISTERED,
  deletedAt: null,
  standing: "suspended",
  standingChangedAt: CHANGED,
  suspensionEndsAt: UNTIL,
  age: 34,
  gender: "woman",
  pond: "Helsinki",
  profile: {
    displayName: "Aino",
    bio: "Likes long walks.",
    bioPreset: null,
    prompts: [{ key: "sunday", answer: "A sauna and a book." }],
    fields: { languages: ["fi", "en"], height: 172, smoking: "never" },
  },
  photos: [
    {
      id: photoId(1),
      state: "approved",
      rejectionReason: null,
      appealable: false,
      uploadedAt: UPLOADED,
    },
    {
      id: photoId(2),
      state: "rejected",
      rejectionReason: "no_person",
      appealable: true,
      uploadedAt: UPLOADED,
    },
  ],
  feedback: [
    { at: SENT, kind: "bug", text: "The map froze.", handledAt: HANDLED },
    { at: SENT, kind: "idea", text: "A dark theme, please.", handledAt: null },
  ],
  audit: [
    {
      at: LOOKED,
      actorIdentityId: STAFF,
      action: "account.view",
      subjectType: "account",
      subjectId: ID,
      detail: null,
    },
    {
      at: CHANGED,
      actorIdentityId: STAFF,
      action: "photo.decide",
      subjectType: "photo",
      subjectId: photoId(2),
      detail: { decision: "reject", reason: "no_person" },
    },
  ],
  ...extra,
});

/** An erased account: its deletion date, nothing else (accounts.ts). */
const tombstone = page({
  state: "deleted",
  stateChangedAt: null,
  registeredAt: null,
  deletedAt: CHANGED,
  standing: null,
  standingChangedAt: null,
  suspensionEndsAt: null,
  age: null,
  gender: null,
  pond: null,
  profile: null,
  photos: [],
  feedback: [],
  audit: [],
});

const sanction = (n: number, extra: Record<string, unknown> = {}) => ({
  id: sanctionId(n),
  accountId: ID,
  kind: "suspend",
  reason: "harassment",
  note: "Wrote something unkind in two chats",
  endsAt: UNTIL,
  createdBy: STAFF,
  createdAt: CHANGED,
  liftedAt: null,
  liftedBy: null,
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  // The staff member's role now (#308), from moderator_roles.
  createdByRole: "moderator",
  liftedByRole: null,
  reviewedByRole: null,
  ...extra,
});
const sanctions = [
  sanction(1),
  sanction(2, {
    kind: "warn",
    reason: "other",
    note: "Asked for a phone number in the first message",
    endsAt: null,
    createdAt: REGISTERED,
    liftedAt: LIFTED,
    liftedBy: STAFF,
    liftedByRole: "moderator",
    reviewNote: "Not what the rule means",
    reviewedBy: STAFF,
    reviewedByRole: "moderator",
    reviewedAt: LIFTED,
  }),
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

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
const on =
  (route: string, answer: () => Promise<Response> | Response): Handler =>
  (req) =>
    req.method === "GET" && path(req) === route ? answer() : null;
const pageOf = (body: unknown, status = 200) =>
  on(`/admin/accounts/${ID}`, () => json(body, status));
const sanctionsOf = (items: unknown[]) =>
  on(`/admin/accounts/${ID}/sanctions`, () => json({ items }));
const cardOf = (n: number, answer: () => Promise<Response> | Response) =>
  on(`/admin/photos/${photoId(n)}/card`, answer);
const cardUrl = (n: number) => `https://media.test/media/k/${n}/card.webp?Signature=s`;
const card = (n: number) => () =>
  json({ url: cardUrl(n), variant: "card", expiresAt: "2030-01-01T00:00:00.000Z" });
const asked = (calls: Request[]) => calls.map((c) => `${c.method} ${path(c)}`);

function show(at = `/accounts/${ID}`, { strict = false } = {}) {
  const screens = (
    <I18nProvider i18n={i18n}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/accounts" element={<AccountLookup />} />
          <Route path="/accounts/:id" element={<AccountPage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  );
  render(strict ? <StrictMode>{screens}</StrictMode> : screens);
}
/** The alt text of a photo a moderator asked to see. */
const shownPhoto = (state: string) => `Photo: ${state}. Uploaded: ${when(UPLOADED)}`;

/** The value a label of a definition list names; a prompt's or a field's label is its key in code. */
function termValue(term: string): string | null | undefined {
  const label = screen.getByText(term, { selector: "dt, dt > code" });
  return label.closest("dt")?.nextElementSibling?.textContent;
}
const sectionTitles = () =>
  screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the way to a person's page", () => {
  it("refuses what is not an account id, asking nothing, and the words go when the field changes", async () => {
    const calls = fetchMock([]);
    show("/accounts");
    expect(screen.getByRole("heading", { level: 2, name: "A person's page" })).toBeInTheDocument();
    const field = screen.getByLabelText("Account id");
    for (const typed of ["", "Aino", `${ID}0`, ID.replace(/-/g, "")]) {
      fireEvent.change(field, { target: { value: typed } });
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open the page" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This is not an account id.");
    }
    fireEvent.change(field, { target: { value: ID.slice(0, 8) } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "A person's page" })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("opens the page of a pasted id, trimmed and in lower case", async () => {
    const calls = fetchMock([pageOf(page()), sanctionsOf(sanctions)]);
    show("/accounts");
    fireEvent.change(screen.getByLabelText("Account id"), {
      target: { value: `  ${ID.toUpperCase()}\t` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open the page" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Account 6f1c1c4e" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(ID)).toBeInTheDocument();
    expect(asked(calls)).toEqual([
      `GET /admin/accounts/${ID}`,
      `GET /admin/accounts/${ID}/sanctions`,
    ]);
    for (const call of calls)
      expect(call.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });
});

describe("a person's page", () => {
  it("names the automatic rules as who did it in the audit when no person did: a rule's shadow ban (#105)", async () => {
    const audit = [
      {
        at: CHANGED,
        actorIdentityId: null,
        action: "sanction.apply",
        subjectType: "account",
        subjectId: ID,
        detail: { rule: "reports", count: 3 },
      },
    ];
    fetchMock([pageOf(page({ audit })), sanctionsOf(sanctions)]);
    show();
    const table = await screen.findByRole("table", { name: "Newest first, at most fifty" });
    const [cells] = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(cells).toEqual([
      when(CHANGED),
      "The automatic rules",
      "sanction.apply",
      "rulereportscount3",
    ]);
  });

  it("says it is loading until the answer comes", () => {
    fetchMock([on(`/admin/accounts/${ID}`, () => new Promise<Response>(() => {}))]);
    show();
    expect(screen.getByRole("heading", { level: 2, name: "Account 6f1c1c4e" })).toBeInTheDocument();
    expect(screen.getByText("Loading the page…")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the state and standing with their dates, the profile as the card shows it, the photos, sanctions, feedback and audit", async () => {
    const calls = fetchMock([pageOf(page()), sanctionsOf(sanctions)]);
    show();
    expect(await screen.findByText(ID, { selector: "code" })).toBeInTheDocument();
    expect(screen.queryByText("Loading the page…")).toBeNull();
    expect(sectionTitles()).toEqual([
      "State",
      "As the card shows them",
      "Photos",
      "Sanctions",
      "Feedback sent",
      "What staff did and saw",
    ]);

    // The raw state (a shadow ban shows to staff) and the identity's standing, each with its date.
    expect(termValue("Account")).toBe(`suspended · ${when(CHANGED)}`);
    expect(termValue("Standing")).toBe(`suspended · ${when(CHANGED)} · until: ${when(UNTIL)}`);
    expect(termValue("Registered")).toBe(when(REGISTERED));
    expect(screen.queryByText("Deleted", { selector: "dt" })).toBeNull();

    // The profile: the prompts and fields by their keys, an array's values joined.
    expect(termValue("Name")).toBe("Aino");
    expect(termValue("Age")).toBe("34");
    expect(termValue("Gender")).toBe("woman");
    expect(termValue("Pond")).toBe("Helsinki");
    expect(termValue("Bio")).toBe("Likes long walks.");
    expect(termValue("sunday")).toBe("A sauna and a book.");
    expect(termValue("languages")).toBe("fi, en");
    expect(termValue("height")).toBe("172");
    expect(termValue("smoking")).toBe("never");

    // The photos: state, the reason a rejection named, the upload's time; no picture yet.
    const photos = screen.getAllByRole("button", { name: "Show the photo" });
    expect(photos).toHaveLength(2);
    const [approved, rejected] = photos.map((button) => button.closest("li"));
    expect(approved).toHaveTextContent(`approved · ${when(UPLOADED)}`);
    expect(rejected).toHaveTextContent(`rejected · no_person · ${when(UPLOADED)}`);
    expect(screen.queryByRole("img")).toBeNull();

    // The sanctions from their own route (#308's history): kind and reason in words, when,
    // until, the note, who applied it, lifted and looked at again by whom, a review's note.
    const sanctionsList = screen.getByText("Suspension").closest("ul") as HTMLElement;
    const [suspended, warned] = within(sanctionsList).getAllByRole("listitem");
    expect(suspended).toHaveTextContent(
      `Suspension · Harassment · ${when(CHANGED)} · until: ${when(UNTIL)}Wrote something unkind in two chatsApplied by: a1b2c3d4, moderator`,
    );
    expect(suspended).not.toHaveTextContent("Lifted:");
    expect(suspended).not.toHaveTextContent("Looked at again:");
    expect(warned).toHaveTextContent(
      `Warning · Other · ${when(REGISTERED)}Asked for a phone number in the first messageApplied by: a1b2c3d4, moderatorLifted: ${when(LIFTED)}. Who: a1b2c3d4, moderatorLooked at again: ${when(LIFTED)}. Who: a1b2c3d4, moderator. Note: Not what the rule means`,
    );
    expect(warned).not.toHaveTextContent("until");

    // The feedback the person sent, handled or not.
    const bug = screen.getByText("bug").closest("li");
    expect(bug).toHaveTextContent(`bug · ${when(SENT)} · handled: ${when(HANDLED)}The map froze.`);
    const idea = screen.getByText("idea").closest("li");
    expect(idea).toHaveTextContent(`idea · ${when(SENT)}A dark theme, please.`);
    expect(idea).not.toHaveTextContent("handled");

    // What staff did and saw: a captioned table, the actor by the start of their id, the detail as JSON.
    const audit = screen.getByRole("table", { name: "Newest first, at most fifty" });
    expect(
      within(audit)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["When", "Who", "What", "Detail"]);
    const rows = within(audit)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      [when(LOOKED), "a1b2c3d4", "account.view", ""],
      [when(CHANGED), "a1b2c3d4", "photo.decide", "decisionrejectreasonno_person"],
    ]);
    expect(audit).not.toHaveTextContent(STAFF);

    // Opening the page asked for the page and the sanctions, never a photo.
    expect(asked(calls)).toEqual([
      `GET /admin/accounts/${ID}`,
      `GET /admin/accounts/${ID}/sanctions`,
    ]);
  });

  it("shows an erased account's deletion date and nothing else, asking for no sanctions", async () => {
    const calls = fetchMock([pageOf(tombstone), sanctionsOf(sanctions)]);
    show();
    expect(await screen.findByText(ID, { selector: "code" })).toBeInTheDocument();
    expect(sectionTitles()).toEqual(["State"]);
    expect(termValue("Account")).toBe("deleted");
    expect(termValue("Deleted")).toBe(when(CHANGED));
    // Nothing that would tie the tombstone to the person's next account (#306).
    expect(screen.queryByText("Standing", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Registered", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("No profile yet.")).toBeNull();
    expect(screen.queryByText("Suspension")).toBeNull();
    // Nor the actions: an erased account's page shows nothing more (#306).
    expect(screen.queryByRole("group", { name: "Actions on this person" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show the photo" })).toBeNull();
    expect(screen.queryByText("None.")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(asked(calls)).toEqual([`GET /admin/accounts/${ID}`]);
  });

  it("opens the page once under StrictMode: one look, one account.view row (#306)", async () => {
    const calls = fetchMock([pageOf(page()), sanctionsOf(sanctions)]);
    show(`/accounts/${ID}`, { strict: true });
    expect(await screen.findByText(ID, { selector: "code" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Wrote something unkind in two chats/)).toBeInTheDocument(),
    );
    expect(asked(calls)).toEqual([
      `GET /admin/accounts/${ID}`,
      `GET /admin/accounts/${ID}/sanctions`,
    ]);
  });

  it("says when there is no profile yet, and None. for every empty section", async () => {
    fetchMock([
      pageOf(
        page({
          state: "registered",
          stateChangedAt: null,
          standing: "ok",
          standingChangedAt: null,
          suspensionEndsAt: null,
          profile: null,
          photos: [],
          feedback: [],
          audit: [],
        }),
      ),
      sanctionsOf([]),
    ]);
    show();
    expect(await screen.findByText("No profile yet.")).toBeInTheDocument();
    expect(termValue("Account")).toBe("registered · –");
    expect(termValue("Standing")).toBe("ok · –");
    expect(screen.queryByText("Name", { selector: "dt" })).toBeNull();
    // Photos, sanctions, feedback and the audit, each empty.
    expect(screen.getAllByText("None.")).toHaveLength(4);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a dash for what a profile leaves empty: no age, gender, pond or bio", async () => {
    fetchMock([
      pageOf(
        page({
          age: null,
          gender: null,
          pond: null,
          profile: { displayName: "Aino", bio: null, bioPreset: null, prompts: [], fields: {} },
        }),
      ),
      sanctionsOf([]),
    ]);
    show();
    expect(await screen.findByText("Aino")).toBeInTheDocument();
    for (const term of ["Age", "Gender", "Pond", "Bio"]) expect(termValue(term)).toBe("–");
    expect(screen.queryByText("sunday")).toBeNull();
  });

  it("says a ready bio line where the person chose one instead of their words", async () => {
    fetchMock([
      pageOf(
        page({
          profile: {
            displayName: "Aino",
            bio: null,
            bioPreset: "photos_speak",
            prompts: [],
            fields: {},
          },
        }),
      ),
      sanctionsOf([]),
    ]);
    show();
    expect(await screen.findByText("Aino")).toBeInTheDocument();
    expect(termValue("Bio")).toBe("A ready line: photos_speak");
  });

  it("says the sanctions could not be loaded and keeps the rest of the page, whether their route fails or cannot be reached", async () => {
    for (const sanctionsAnswer of [
      () => failure(500, "internal_error"),
      (): Response => {
        throw new TypeError("Failed to fetch");
      },
    ]) {
      fetchMock([pageOf(page()), on(`/admin/accounts/${ID}/sanctions`, sanctionsAnswer)]);
      show();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The sanctions could not be loaded.",
      );
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByText("The page could not be loaded.")).toBeNull();
      expect(termValue("Name")).toBe("Aino");
      expect(screen.getAllByRole("button", { name: "Show the photo" })).toHaveLength(2);
      expect(screen.getByText(/The map froze\./)).toBeInTheDocument();
      expect(screen.getByRole("table")).toBeInTheDocument();
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it.each([404, 400])(
    "says no account has the id on a %i, and asks for no sanctions",
    async (status) => {
      const calls = fetchMock([
        on(`/admin/accounts/${ID}`, () =>
          failure(status, status === 404 ? "not_found" : "validation_failed"),
        ),
      ]);
      show();
      expect(await screen.findByText("No account has this id.")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Loading the page…")).toBeNull();
      expect(asked(calls)).toEqual([`GET /admin/accounts/${ID}`]);
    },
  );

  it("says the page could not be loaded when the API fails or cannot be reached", async () => {
    for (const answer of [
      () => failure(500, "internal_error"),
      (): Response => {
        throw new TypeError("Failed to fetch");
      },
    ]) {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const calls = fetchMock([on(`/admin/accounts/${ID}`, answer)]);
      show();
      expect(await screen.findByRole("alert")).toHaveTextContent("The page could not be loaded.");
      expect(screen.queryByText("Loading the page…")).toBeNull();
      expect(screen.queryByText("No account has this id.")).toBeNull();
      expect(asked(calls)).toEqual([`GET /admin/accounts/${ID}`]);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("leaves a refused page to the shell: no words of its own and nothing more asked (#302)", async () => {
    const calls = fetchMock([on(`/admin/accounts/${ID}`, () => failure(403, "admin_forbidden"))]);
    show();
    await waitFor(() => expect(screen.queryByText("Loading the page…")).toBeNull());
    expect(screen.getByRole("heading", { level: 2, name: "Account 6f1c1c4e" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No account has this id.")).toBeNull();
    expect(screen.queryByText("The page could not be loaded.")).toBeNull();
    expect(asked(calls)).toEqual([`GET /admin/accounts/${ID}`]);
  });

  it("says the page could not be loaded when the answer is outside the contract, and logs no person's data", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock([pageOf({ ...page(), state: "frozen" }), sanctionsOf(sanctions)]);
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("The page could not be loaded.");
    expect(screen.queryByText("Aino")).toBeNull();
    expect(logged).toHaveBeenCalledWith("account page load failed", expect.anything());
    expect(String(logged.mock.calls[0]?.[1])).not.toContain("Aino");
  });
});

describe("a photo on a person's page", () => {
  it("is asked for only when the moderator presses Show the photo, one photo at a time", async () => {
    const calls = fetchMock([pageOf(page()), sanctionsOf([]), cardOf(1, card(1))]);
    show();
    const [first, second] = await screen.findAllByRole("button", { name: "Show the photo" });
    if (!first || !second) throw new Error("no buttons");
    expect(asked(calls).filter((call) => call.endsWith("/card"))).toEqual([]);
    fireEvent.click(first);
    const image = await screen.findByRole("img", { name: shownPhoto("approved") });
    expect(image).toHaveAttribute("src", cardUrl(1));
    // The picture takes the focus the button had, so a keyboard user is not left on the page's body.
    await waitFor(() => expect(image).toHaveFocus());
    expect(image.closest("li")).toHaveTextContent(`approved · ${when(UPLOADED)}`);
    expect(asked(calls).filter((call) => call.endsWith("/card"))).toEqual([
      `GET /admin/photos/${photoId(1)}/card`,
    ]);
    // The other photo still waits to be asked for.
    expect(screen.getAllByRole("button", { name: "Show the photo" })).toHaveLength(1);
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("says a failed photo could not be shown, keeps the button, and shows it on the next press", async () => {
    let answer = (): Response => failure(500, "internal_error");
    fetchMock([pageOf(page()), sanctionsOf([]), cardOf(2, () => answer())]);
    show();
    const buttons = await screen.findAllByRole("button", { name: "Show the photo" });
    fireEvent.click(buttons[1] as HTMLElement);
    expect(await screen.findByRole("alert")).toHaveTextContent("The photo could not be shown.");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Show the photo" })).toHaveLength(2);

    answer = card(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Show the photo" })[1] as HTMLElement);
    expect(await screen.findByRole("img", { name: shownPhoto("rejected") })).toHaveAttribute(
      "src",
      cardUrl(2),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves a refused photo to the shell: no words of its own, both buttons stay (#302)", async () => {
    const calls = fetchMock([
      pageOf(page()),
      sanctionsOf([]),
      cardOf(1, () => failure(403, "admin_forbidden")),
    ]);
    show();
    const [first] = await screen.findAllByRole("button", { name: "Show the photo" });
    fireEvent.click(first as HTMLElement);
    await waitFor(() =>
      expect(asked(calls).filter((call) => call.endsWith("/card"))).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Show the photo" })[0]).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Show the photo" })).toHaveLength(2);
  });

  it("asks once for a photo pressed twice before its answer: one look, one photo.view row", async () => {
    let release: (res: Response) => void = () => {};
    const calls = fetchMock([
      pageOf(page()),
      sanctionsOf([]),
      cardOf(
        1,
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    ]);
    show();
    const [first] = await screen.findAllByRole("button", { name: "Show the photo" });
    if (!first) throw new Error("no button");
    fireEvent.click(first);
    fireEvent.click(first);
    await waitFor(() => expect(first).toHaveAttribute("aria-busy", "true"));
    expect(first).toBeEnabled();
    fireEvent.click(first);
    expect(asked(calls).filter((call) => call.endsWith("/card"))).toEqual([
      `GET /admin/photos/${photoId(1)}/card`,
    ]);
    release(card(1)());
    expect(await screen.findByRole("img", { name: shownPhoto("approved") })).toHaveAttribute(
      "src",
      cardUrl(1),
    );
    expect(asked(calls).filter((call) => call.endsWith("/card"))).toHaveLength(1);
  });

  it("says the photo could not be shown when the answer is outside the contract", async () => {
    fetchMock([pageOf(page()), sanctionsOf([]), cardOf(1, () => json({ url: "not a url" }))]);
    show();
    const [first] = await screen.findAllByRole("button", { name: "Show the photo" });
    fireEvent.click(first as HTMLElement);
    expect(await screen.findByRole("alert")).toHaveTextContent("The photo could not be shown.");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says the photo could not be shown when its request cannot be reached", async () => {
    fetchMock([
      pageOf(page()),
      sanctionsOf([]),
      cardOf(1, () => {
        throw new TypeError("Failed to fetch");
      }),
    ]);
    show();
    const [first] = await screen.findAllByRole("button", { name: "Show the photo" });
    fireEvent.click(first as HTMLElement);
    expect(await screen.findByRole("alert")).toHaveTextContent("The photo could not be shown.");
    expect(screen.queryByRole("img")).toBeNull();
  });
});

// Taking an approved photo down (#477): the button beside an approved photo
// only, a confirm step with the effect in words and no reason preset, the
// page read again after it, and every refusal in words.
describe("taking a photo down on a person's page", () => {
  const STEP = "Take down this photo";
  const REASON = "Reason the person is told";
  const DONE = "Taken down. Nobody else is given the photo from now on.";
  const decisionOf =
    (n: number, answer: (req: Request) => Promise<Response> | Response): Handler =>
    (req) =>
      req.method === "POST" && path(req) === `/admin/photos/${photoId(n)}/decision`
        ? answer(req)
        : null;
  const decided = (n: number) =>
    json({ photoId: photoId(n), state: "rejected", rejectionReason: "other" });
  const photo = (n: number, state: string, rejectionReason: string | null = null) => ({
    id: photoId(n),
    state,
    rejectionReason,
    appealable: false,
    uploadedAt: UPLOADED,
  });
  const decisions = (calls: Request[]) => asked(calls).filter((call) => call.startsWith("POST "));

  /** Opens the step from the keyboard, as it were: the button has the focus when pressed. */
  async function openStep(at = 0) {
    const button = (await screen.findAllByRole("button", { name: "Take down…" }))[at];
    if (!button) throw new Error("no Take down button");
    button.focus();
    fireEvent.click(button);
    return screen.getByRole("dialog", { name: STEP });
  }
  const choose = (step: HTMLElement, reason: string) =>
    fireEvent.change(within(step).getByRole("combobox", { name: REASON }), {
      target: { value: reason },
    });

  it("is offered beside an approved photo only, described by the photo's own line", async () => {
    fetchMock([
      pageOf(page({ photos: [photo(1, "approved"), photo(2, "rejected", "no_person")] })),
      sanctionsOf([]),
    ]);
    show();
    const button = await screen.findByRole("button", { name: "Take down…" });
    expect(screen.getAllByRole("button", { name: "Take down…" })).toHaveLength(1);
    expect(button).toHaveAccessibleDescription(`approved · ${when(UPLOADED)}`);
    expect(button.closest("li")).toHaveTextContent(`approved · ${when(UPLOADED)}`);
  });

  it.each([
    [1, true],
    [2, true],
    [3, false],
  ])("with %i approved photos, says the person drops out of every round: %s", async (n, says) => {
    const photos = Array.from({ length: n }, (_, i) => photo(i + 1, "approved"));
    fetchMock([
      pageOf(page({ photos: [...photos, photo(9, "rejected", "other")] })),
      sanctionsOf([]),
    ]);
    show();
    const step = await openStep();
    const words =
      "This leaves them fewer than 2 approved photos: until another is approved, nobody is shown their card and they get no round.";
    if (says) expect(step).toHaveTextContent(words);
    else expect(step).not.toHaveTextContent("fewer than");
  });

  it.each(["pending", "queued", "rejected"])("is not offered beside a %s photo", async (state) => {
    fetchMock([pageOf(page({ photos: [photo(1, state)] })), sanctionsOf([])]);
    show();
    await screen.findByRole("button", { name: "Show the photo" });
    expect(screen.queryByRole("button", { name: "Take down…" })).toBeNull();
  });

  it("takes the photo down through a confirm step with a reason chosen on purpose, reads the page again and says so", async () => {
    let current = page({ photos: [photo(1, "approved"), photo(2, "rejected", "no_person")] });
    const bodies: unknown[] = [];
    const calls = fetchMock([
      on(`/admin/accounts/${ID}`, () => json(current)),
      sanctionsOf([]),
      decisionOf(1, async (req) => {
        bodies.push(await req.json());
        current = page({
          photos: [photo(1, "rejected", "other"), photo(2, "rejected", "no_person")],
        });
        return decided(1);
      }),
    ]);
    show();
    const step = await openStep();
    expect(step).toHaveTextContent("Nobody else is given this photo from now on");
    expect(step).toHaveTextContent("it is not a sanction");
    // No reason is preset (#250): the step waits for one chosen on purpose.
    const select = within(step).getByRole("combobox", { name: REASON });
    expect(select).toHaveValue("");
    const confirm = within(step).getByRole("button", { name: "Take down" });
    expect(confirm).toBeDisabled();
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Choose a reason",
      "Nudity",
      "No person visible",
      "Several people",
      "A child appears",
      "Violence or weapons",
      "Contact details, handle or link",
      "Other",
    ]);
    choose(step, "other");
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies).toEqual([{ decision: "take_down", reason: "other" }]);
    // The line says it and takes the focus, since the button goes with the change.
    const done = await screen.findByText(DONE);
    await waitFor(() => expect(done).toHaveFocus());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Take down…" })).toBeNull());
    const [first] = screen.getAllByRole("button", { name: "Show the photo" });
    expect(first?.closest("li")).toHaveTextContent(`rejected · other · ${when(UPLOADED)}`);
    expect(asked(calls)).toEqual([
      `GET /admin/accounts/${ID}`,
      `GET /admin/accounts/${ID}/sanctions`,
      `POST /admin/photos/${photoId(1)}/decision`,
      `GET /admin/accounts/${ID}`,
      `GET /admin/accounts/${ID}/sanctions`,
    ]);
  });

  it("clears the line when the next step opens, so a second take-down is said again", async () => {
    let current = page({ photos: [photo(1, "approved"), photo(2, "approved")] });
    fetchMock([
      on(`/admin/accounts/${ID}`, () => json(current)),
      sanctionsOf([]),
      decisionOf(1, () => {
        current = page({ photos: [photo(1, "rejected", "other"), photo(2, "approved")] });
        return decided(1);
      }),
      decisionOf(2, () => {
        current = page({
          photos: [photo(1, "rejected", "other"), photo(2, "rejected", "other")],
        });
        return decided(2);
      }),
    ]);
    show();
    let step = await openStep(0);
    choose(step, "other");
    fireEvent.click(within(step).getByRole("button", { name: "Take down" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Take down…" })).toHaveLength(1),
    );
    expect(screen.getByText(DONE)).toBeInTheDocument();

    step = await openStep(0);
    expect(screen.queryByText(DONE)).toBeNull();
    choose(step, "other");
    fireEvent.click(within(step).getByRole("button", { name: "Take down" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Take down…" })).toBeNull());
    await waitFor(() => expect(screen.getByText(DONE)).toHaveFocus());
  });

  it.each([
    [
      "taken down meanwhile (409)",
      () => failure(409, "photo_not_approved"),
      "The photo is no longer approved: it was taken down meanwhile. Reload the page to see it as it is.",
    ],
    [
      "gone (404)",
      () => failure(404, "not_found"),
      "The photo is gone: its owner removed it meanwhile.",
    ],
    [
      "any other failure",
      () => failure(500, "internal_error"),
      "The take-down may not have been saved. Reload the page to see where it stands before trying again.",
    ],
    [
      "an answer outside the contract",
      () => json({ photoId: "p1", state: "rejected", rejectionReason: "other" }),
      "The take-down may not have been saved. Reload the page to see where it stands before trying again.",
    ],
    [
      "no answer at all",
      (): Response => {
        throw new TypeError("Failed to fetch");
      },
      "The take-down may not have been saved. Reload the page to see where it stands before trying again.",
    ],
  ])("says %s in words, keeps the step open and the page as it was", async (_, answer, words) => {
    const calls = fetchMock([pageOf(page()), sanctionsOf([]), decisionOf(1, answer)]);
    show();
    const step = await openStep();
    choose(step, "nudity");
    fireEvent.click(within(step).getByRole("button", { name: "Take down" }));
    expect(await within(step).findByRole("alert")).toHaveTextContent(words);
    expect(screen.getByRole("dialog", { name: STEP })).toBe(step);
    expect(screen.queryByText(DONE)).toBeNull();
    expect(asked(calls)).toEqual([
      `GET /admin/accounts/${ID}`,
      `GET /admin/accounts/${ID}/sanctions`,
      `POST /admin/photos/${photoId(1)}/decision`,
    ]);
  });

  it("leaves a refused take-down to the shell: the step closes with no words of its own (#302)", async () => {
    const calls = fetchMock([
      pageOf(page()),
      sanctionsOf([]),
      decisionOf(1, () => failure(403, "admin_forbidden")),
    ]);
    show();
    const step = await openStep();
    choose(step, "other");
    fireEvent.click(within(step).getByRole("button", { name: "Take down" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(DONE)).toBeNull();
    expect(screen.getByRole("button", { name: "Take down…" })).toBeInTheDocument();
    expect(decisions(calls)).toHaveLength(1);
    expect(asked(calls).filter((call) => call === `GET /admin/accounts/${ID}`)).toHaveLength(1);
  });

  it("closes on Cancel or Escape asking nothing, and gives the focus back to its button", async () => {
    const calls = fetchMock([pageOf(page()), sanctionsOf([])]);
    show();
    let step = await openStep();
    choose(step, "other");
    fireEvent.click(within(step).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const button = screen.getByRole("button", { name: "Take down…" });
    expect(button).toHaveFocus();

    step = await openStep();
    // Opened anew, nothing of the last choice is kept.
    expect(within(step).getByRole("combobox", { name: REASON })).toHaveValue("");
    fireEvent.keyDown(within(step).getByRole("combobox", { name: REASON }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
    expect(decisions(calls)).toEqual([]);
  });

  it("sends nothing when the form is submitted without a reason, by Enter for one", async () => {
    const calls = fetchMock([pageOf(page()), sanctionsOf([])]);
    show();
    const step = await openStep();
    const form = within(step).getByRole("combobox", { name: REASON }).closest("form");
    fireEvent.submit(form as HTMLFormElement);
    expect(screen.getByRole("dialog", { name: STEP })).toBe(step);
    expect(decisions(calls)).toEqual([]);
  });
});
