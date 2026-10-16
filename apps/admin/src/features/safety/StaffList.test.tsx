import { formatDateTime } from "@kuutti/i18n";
import { I18nProvider } from "@kuutti/i18n/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { StaffList } from "./StaffList.tsx";

// The staff list as an admin reads it (#310): who holds which role, when and
// by whom it was granted, and the last sign-in to the panel, "Never" for one
// who has not signed in. Requests are answered by a fake fetch keyed on
// method and path.

const ADMIN = "3c9d0f5e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const MODERATOR = "7a2d2d5f-0b9f-4b1c-8d4b-1d9e2f3a4b5c";
const RESEARCHER = "9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0";

const member = (identityId: string, extra: Record<string, unknown> = {}) => ({
  identityId,
  role: "moderator",
  grantedAt: "2026-09-25T10:00:00.000Z",
  grantedBy: "maintainer",
  lastSignInAt: null,
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (code: string, status: number) =>
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
const isStaff = (req: Request) => req.method === "GET" && path(req) === "/admin/staff";
const answer =
  (respond: () => Response): Handler =>
  (req) =>
    isStaff(req) ? respond() : null;
const staffOf = (...items: unknown[]) => answer(() => json({ items }));

function show() {
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <StaffList />
      </MemoryRouter>
    </I18nProvider>,
  );
}

const cells = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((tr) =>
      within(tr)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the staff list", () => {
  it("is busy while it loads, and says where roles are granted", async () => {
    fetchMock([staffOf()]);
    show();
    expect(screen.getByText("Loading the staff…")).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByText(
        "Roles are granted and revoked by the maintainer's moderator tool, not here.",
      ),
    ).toBeInTheDocument();
    await screen.findByRole("table");
    expect(screen.queryByText("Loading the staff…")).toBeNull();
  });

  it("lists every member with role, grant, granter and last sign-in, Never for one who has not signed in", async () => {
    const calls = fetchMock([
      staffOf(
        member(ADMIN, {
          role: "admin",
          grantedAt: "2026-09-01T08:00:00.000Z",
          lastSignInAt: "2026-10-15T07:30:00.000Z",
        }),
        member(MODERATOR, { grantedBy: ADMIN }),
        member(RESEARCHER, { role: "researcher", grantedAt: "2026-10-01T12:00:00.000Z" }),
      ),
    ]);
    show();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("3 members of staff")).toBeInTheDocument();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Identity", "Role", "Granted", "By", "Last sign-in"]);
    expect(cells(table)).toEqual([
      [
        ADMIN,
        "admin",
        formatDateTime("en", new Date("2026-09-01T08:00:00.000Z")),
        "maintainer",
        formatDateTime("en", new Date("2026-10-15T07:30:00.000Z")),
      ],
      [
        MODERATOR,
        "moderator",
        formatDateTime("en", new Date("2026-09-25T10:00:00.000Z")),
        ADMIN,
        "Never",
      ],
      [
        RESEARCHER,
        "researcher",
        formatDateTime("en", new Date("2026-10-01T12:00:00.000Z")),
        "maintainer",
        "Never",
      ],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });

  it("counts one member in the singular, and none as zero", async () => {
    fetchMock([staffOf(member(ADMIN, { role: "admin" }))]);
    show();
    expect(await screen.findByText("1 member of staff")).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();

    fetchMock([staffOf()]);
    show();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("0 members of staff")).toBeInTheDocument();
    expect(cells(table)).toEqual([]);
  });

  it("asks again on refresh and shows what is true now", async () => {
    let asked = 0;
    const calls = fetchMock([
      answer(() =>
        json({
          items:
            asked++ === 0
              ? [member(MODERATOR)]
              : [member(MODERATOR, { lastSignInAt: "2026-10-16T09:00:00.000Z" })],
        }),
      ),
    ]);
    show();
    expect(await screen.findByText("Never")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText(formatDateTime("en", new Date("2026-10-16T09:00:00.000Z"))),
    ).toBeInTheDocument();
    expect(screen.queryByText("Never")).toBeNull();
    expect(calls.filter(isStaff)).toHaveLength(2);
  });

  it("says the staff could not be loaded when the API fails, cannot be reached, or answers outside the contract", async () => {
    const cases: [() => Response, boolean][] = [
      [() => failure("internal_error", 500), false],
      [
        () => {
          throw new TypeError("Failed to fetch");
        },
        true,
      ],
      [() => json({ items: [member(ADMIN, { role: "owner" })] }), true],
      [() => json({ items: [member("not-a-uuid")] }), true],
    ];
    for (const [respond, logs] of cases) {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      fetchMock([answer(respond)]);
      show();
      expect(await screen.findByRole("alert")).toHaveTextContent("The staff could not be loaded.");
      expect(screen.queryByText("Loading the staff…")).toBeNull();
      expect(screen.queryByRole("table")).toBeNull();
      if (logs) expect(logged).toHaveBeenCalledWith("staff load failed", expect.anything());
      else expect(logged).not.toHaveBeenCalled();
      cleanup();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("leaves a refused list to the shell: no table and no failure of its own (#302)", async () => {
    const calls = fetchMock([answer(() => failure("admin_forbidden", 403))]);
    show();
    await waitFor(() => expect(screen.queryByText("Loading the staff…")).toBeNull());
    expect(screen.getByRole("heading", { level: 2, name: "Staff" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(calls.filter(isStaff)).toHaveLength(1);
  });
});
