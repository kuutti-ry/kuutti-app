import { I18nProvider } from "@kuutti/i18n/react";
import { Sanction, type SanctionKind } from "@kuutti/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n.ts";
import { setTokenSource } from "../../lib/api.ts";
import { StaffRole } from "../../lib/role.ts";
import { SanctionActions } from "./Sanctions.tsx";

// The actions on a person on their own (#308, #312), as a person's page and a
// report's page both use them: only an apply reaches onApplied, with the
// sanction the API answered, parsed, and the kind the step asked for; a
// refusal and a 403 never do. Lifting and looking again are not among these
// actions at all: they stay on the person's page (Sanctions).

const ID = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const ROUTE = `/admin/accounts/${ID}/sanctions`;

/** The API's answer, with a key the contract does not name: what onApplied gets is the parsed sanction. */
const answer = {
  id: "5a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
  accountId: ID,
  kind: "warn",
  reason: "harassment",
  note: "Spam links",
  endsAt: null,
  createdBy: "a1b2c3d4-9a8e-4a0b-9c3a-0c8d1e2f3a99",
  createdAt: "2026-10-11T08:30:00.000Z",
  liftedAt: null,
  liftedBy: null,
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  extra: "not in the contract",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

function answering(response: () => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      return response();
    }),
  );
  return calls;
}

function show() {
  const onOpen = vi.fn();
  const onApplied = vi.fn(async (_sanction: Sanction, _asked: SanctionKind) => undefined);
  render(
    <I18nProvider i18n={i18n}>
      <StaffRole.Provider value="moderator">
        <SanctionActions
          accountId={ID}
          legend="Act"
          also="And one more thing happens."
          onOpen={onOpen}
          onApplied={onApplied}
        />
      </StaffRole.Provider>
    </I18nProvider>,
  );
  return { onOpen, onApplied };
}

/** Opens Warn, fills it in and sends it. */
function apply() {
  fireEvent.click(screen.getByRole("button", { name: "Warn" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Reason" }), {
    target: { value: "harassment" },
  });
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Note/ }), {
    target: { value: "Spam links" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
  return dialog;
}

beforeEach(() => setTokenSource(() => "t".repeat(43)));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the actions on a person, on their own", () => {
  it("offers the applies only, under the legend given, and says the extra line in the step", () => {
    answering(() => json(answer, 201));
    const { onOpen } = show();
    const group = screen.getByRole("group", { name: "Act" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Warn", "Hide from others (shadow ban)", "Suspend until a day"]);
    expect(screen.queryByRole("button", { name: "Lift" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Look at it again" })).toBeNull();
    fireEvent.click(within(group).getByRole("button", { name: "Warn" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toHaveTextContent("And one more thing happens.");
  });

  it("hands an apply's parsed sanction and the kind asked for to onApplied, and closes the step", async () => {
    const calls = answering(() => json(answer, 201));
    const { onApplied } = show();
    apply();
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onApplied).toHaveBeenCalledWith(Sanction.parse(answer), "warn");
    expect(onApplied.mock.calls[0]?.[0]).not.toHaveProperty("extra");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toEqual([`POST ${ROUTE}`]);
  });

  it.each([
    ["a refusal in words", () => failure(409, "staff_target"), true],
    ["a refusal left to the shell", () => failure(403, "admin_forbidden"), false],
  ])("never calls onApplied after %s", async (_, response, stays) => {
    const calls = answering(response);
    const { onApplied } = show();
    apply();
    await waitFor(() => expect(calls).toHaveLength(1));
    if (stays) expect(await screen.findByRole("alert")).toBeInTheDocument();
    else await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onApplied).not.toHaveBeenCalled();
  });
});
