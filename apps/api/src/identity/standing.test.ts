import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import { AccountState, type IdentityStanding } from "@kuutti/schema";
import fc from "fast-check";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { hashToken } from "../lib/auth-middleware.ts";
import { type TestContext, test } from "../test/harness.ts";
import {
  type AccountStanding,
  endSessionsForSanction,
  lockAccountForSanction,
  type OpenSanctions,
  type Settled,
  settle,
  settleStanding,
  visibleState,
} from "./standing.ts";

// The account's state and the identity's standing, settled from the open
// sanctions (#307, ADR-024 §2 and §4). The pure half exhaustively and by
// property; the database half on the real database, in the test's rolled-back
// transaction. The routes and the night that call these are the safety
// slice's tests.

const SEEDED = { seed: 20261016 };

const T0 = new Date("2026-10-01T09:00:00Z");
const T = new Date("2026-10-20T09:00:00Z");
// The start of 22.10.2026 in Finland (EEST, UTC+3), the end of a suspension (§5).
const ENDS = new Date("2026-10-21T21:00:00Z");

// ---------------------------------------------------------------------------
// settle(): every reachable state against every combination of what is open
// ---------------------------------------------------------------------------

type Expected = Pick<AccountStanding, "state" | "pausedFrom" | "sanctionedFrom">;
const as = (
  state: AccountState,
  pausedFrom: AccountState | null,
  sanctionedFrom: AccountState | null,
): Expected => ({ state, pausedFrom, sanctionedFrom });

/**
 * One reachable account, with what ADR-024 §2 settles it to under each of the
 * four outcomes the open sanctions can have: an open ban, an open suspension
 * (and no ban), nothing that touches the standing with no shadow ban, and the
 * same with an open shadow ban.
 */
type Row = {
  label: string;
  current: AccountStanding;
  banned: Expected;
  suspended: Expected;
  ok: Expected;
  shadow: Expected;
};

const ROWS: Row[] = [
  {
    label: "registered",
    current: as("registered", null, null),
    banned: as("banned", null, "registered"),
    suspended: as("suspended", null, "registered"),
    // A registered account stays registered; its activation honours a shadow ban.
    ok: as("registered", null, null),
    shadow: as("registered", null, null),
  },
  {
    label: "active",
    current: as("active", null, null),
    banned: as("banned", null, "active"),
    suspended: as("suspended", null, "active"),
    ok: as("active", null, null),
    shadow: as("shadow_banned", null, null),
  },
  {
    label: "paused from active",
    current: as("paused", "active", null),
    banned: as("banned", "active", "paused"),
    suspended: as("suspended", "active", "paused"),
    ok: as("paused", "active", null),
    shadow: as("paused", "shadow_banned", null),
  },
  {
    label: "paused from shadow_banned",
    current: as("paused", "shadow_banned", null),
    banned: as("banned", "shadow_banned", "paused"),
    suspended: as("suspended", "shadow_banned", "paused"),
    ok: as("paused", "active", null),
    shadow: as("paused", "shadow_banned", null),
  },
  {
    label: "shadow_banned",
    current: as("shadow_banned", null, null),
    banned: as("banned", null, "active"),
    suspended: as("suspended", null, "active"),
    ok: as("active", null, null),
    shadow: as("shadow_banned", null, null),
  },
  ...(["suspended", "banned"] as const).flatMap((held): Row[] => [
    {
      label: `${held} from registered`,
      current: as(held, null, "registered"),
      banned: as("banned", null, "registered"),
      suspended: as("suspended", null, "registered"),
      ok: as("registered", null, null),
      shadow: as("registered", null, null),
    },
    {
      label: `${held} from active`,
      current: as(held, null, "active"),
      banned: as("banned", null, "active"),
      suspended: as("suspended", null, "active"),
      ok: as("active", null, null),
      shadow: as("shadow_banned", null, null),
    },
    {
      label: `${held} from paused (paused_from active)`,
      current: as(held, "active", "paused"),
      banned: as("banned", "active", "paused"),
      suspended: as("suspended", "active", "paused"),
      ok: as("paused", "active", null),
      shadow: as("paused", "shadow_banned", null),
    },
    {
      label: `${held} from paused (paused_from shadow_banned)`,
      current: as(held, "shadow_banned", "paused"),
      banned: as("banned", "shadow_banned", "paused"),
      suspended: as("suspended", "shadow_banned", "paused"),
      // The shadow ban lifted meanwhile does not come back with the break.
      ok: as("paused", "active", null),
      shadow: as("paused", "shadow_banned", null),
    },
    {
      // Set by hand before sanctioned_from existed (the demo's old ban): reads as active.
      label: `${held} from null`,
      current: as(held, null, null),
      banned: as("banned", null, "active"),
      suspended: as("suspended", null, "active"),
      ok: as("active", null, null),
      shadow: as("shadow_banned", null, null),
    },
  ]),
  {
    label: "deleted",
    current: as("deleted", null, null),
    banned: as("deleted", null, null),
    suspended: as("deleted", null, null),
    ok: as("deleted", null, null),
    shadow: as("deleted", null, null),
  },
];

const OPENS: { label: string; open: OpenSanctions }[] = [false, true].flatMap((ban) =>
  [null, ENDS].flatMap((suspensionEndsAt) =>
    [false, true].map((shadowBan) => ({
      label: `ban ${ban}, suspension ${suspensionEndsAt ? "open" : "none"}, shadow ban ${shadowBan}`,
      open: { ban, suspensionEndsAt, shadowBan },
    })),
  ),
);

function outcome(open: OpenSanctions): "banned" | "suspended" | "ok" | "shadow" {
  if (open.ban) return "banned";
  if (open.suspensionEndsAt) return "suspended";
  return open.shadowBan ? "shadow" : "ok";
}

const CASES = ROWS.flatMap((row) =>
  OPENS.map(({ label, open }) => {
    const standing: IdentityStanding = open.ban
      ? "banned"
      : open.suspensionEndsAt
        ? "suspended"
        : "ok";
    const expected: Settled = {
      ...row[outcome(open)],
      standing,
      // The column the bank login's refusal names: only while suspended.
      suspensionEndsAt: standing === "suspended" ? ENDS : null,
    };
    return { name: `${row.label}; ${label}`, current: row.current, open, expected };
  }),
);

describe("settle", () => {
  it("covers every account state", () => {
    const covered = new Set(ROWS.map((r) => r.current.state));
    expect([...covered].sort()).toEqual([...AccountState.options].sort());
  });

  it.each(CASES)("$name", ({ current, open, expected }) => {
    expect(settle(current, open)).toEqual(expected);
  });

  it("returns a new value and leaves its input as it was", () => {
    const current = as("paused", "active", null);
    const copy = { ...current };
    settle(current, { ban: true, suspensionEndsAt: null, shadowBan: true });
    expect(current).toEqual(copy);
  });
});

describe("visibleState", () => {
  it.each([
    ["registered", "registered"],
    ["active", "active"],
    ["paused", "paused"],
    // A shadow ban shows to nobody, least of all its owner (#105).
    ["shadow_banned", "active"],
    ["suspended", "suspended"],
    ["banned", "banned"],
    ["deleted", "deleted"],
  ] as const)("%s reads as %s", (state, seen) => {
    expect(visibleState(state)).toBe(seen);
  });

  it("never says shadow_banned, whatever the state", () => {
    expect(AccountState.options.map(visibleState)).not.toContain("shadow_banned");
  });
});

// ---------------------------------------------------------------------------
// settle(): properties over every sequence of sanctions
// ---------------------------------------------------------------------------

const stateArb = fc.constantFrom(...AccountState.options);
const openArb: fc.Arbitrary<OpenSanctions> = fc.record({
  ban: fc.boolean(),
  suspensionEndsAt: fc.option(
    fc.date({
      min: new Date("2026-01-01T00:00:00Z"),
      max: new Date("2027-12-31T00:00:00Z"),
      noInvalidDate: true,
    }),
    { nil: null },
  ),
  shadowBan: fc.boolean(),
});
const NOTHING: OpenSanctions = { ban: false, suspensionEndsAt: null, shadowBan: false };

/** The three bases an account has without sanctions (§2), as a person reaches them. */
const BASES: AccountStanding[] = [
  as("registered", null, null),
  as("active", null, null),
  as("paused", "active", null),
];
const baseArb = fc.constantFrom(...BASES);

const strip = (s: Settled): AccountStanding => ({
  state: s.state,
  pausedFrom: s.pausedFrom,
  sanctionedFrom: s.sanctionedFrom,
});

/** Settles `from` through every step in turn, as a run of applies and lifts would. */
function through(from: AccountStanding, steps: OpenSanctions[]): AccountStanding {
  return steps.reduce((acc, open) => strip(settle(acc, open)), from);
}

/** Any account a person can reach: a base, then any run of sanctions; or a tombstone. */
const reachableArb: fc.Arbitrary<AccountStanding> = fc.oneof(
  fc.tuple(baseArb, fc.array(openArb, { maxLength: 6 })).map(([b, steps]) => through(b, steps)),
  fc.constant(as("deleted", null, null)),
);

describe("settle, for any run of sanctions", () => {
  it("settling the settled result again with the same open sanctions changes nothing", () => {
    fc.assert(
      fc.property(reachableArb, openArb, (current, open) => {
        const once = settle(current, open);
        expect(settle(strip(once), open)).toEqual(once);
      }),
      SEEDED,
    );
  });

  it("with nothing open the account is never suspended, banned or shadow-banned, and the standing is ok", () => {
    fc.assert(
      fc.property(reachableArb, (current) => {
        const settled = settle(current, NOTHING);
        expect(["suspended", "banned", "shadow_banned"]).not.toContain(settled.state);
        expect(settled.pausedFrom).not.toBe("shadow_banned");
        expect(settled.sanctionedFrom).toBeNull();
        expect(settled.standing).toBe("ok");
        expect(settled.suspensionEndsAt).toBeNull();
      }),
      SEEDED,
    );
  });

  it("a deleted account's state, paused_from and sanctioned_from never change", () => {
    const maybeState = fc.option(stateArb, { nil: null });
    fc.assert(
      fc.property(maybeState, maybeState, openArb, (pausedFrom, sanctionedFrom, open) => {
        const settled = settle({ state: "deleted", pausedFrom, sanctionedFrom }, open);
        expect(strip(settled)).toEqual({ state: "deleted", pausedFrom, sanctionedFrom });
        // The standing still follows what is open: a ban binds the identity (TD-7).
        expect(settled.standing).toBe(
          open.ban ? "banned" : open.suspensionEndsAt ? "suspended" : "ok",
        );
      }),
      SEEDED,
    );
  });

  it("the standing is banned whenever a ban is open, and so is every live account", () => {
    fc.assert(
      fc.property(reachableArb, openArb, (current, open) => {
        const settled = settle(current, { ...open, ban: true });
        expect(settled.standing).toBe("banned");
        expect(settled.suspensionEndsAt).toBeNull();
        expect(settled.state).toBe(current.state === "deleted" ? "deleted" : "banned");
      }),
      SEEDED,
    );
  });

  it("an open suspension without a ban suspends every live account until the latest end", () => {
    fc.assert(
      fc.property(reachableArb, openArb, (current, open) => {
        const ends = open.suspensionEndsAt ?? ENDS;
        const settled = settle(current, { ...open, ban: false, suspensionEndsAt: ends });
        expect(settled.standing).toBe("suspended");
        expect(settled.suspensionEndsAt).toEqual(ends);
        expect(settled.state).toBe(current.state === "deleted" ? "deleted" : "suspended");
      }),
      SEEDED,
    );
  });

  it("a suspension and its end bring every base back as it was", () => {
    for (const base of BASES) {
      const suspended = settle(base, { ...NOTHING, suspensionEndsAt: ENDS });
      expect(suspended.state).toBe("suspended");
      expect(suspended.sanctionedFrom).toBe(base.state);
      expect(settle(strip(suspended), NOTHING)).toEqual({
        ...base,
        standing: "ok",
        suspensionEndsAt: null,
      });
    }
  });

  it("the base survives any run of sanctions: nothing open returns to it, a shadow ban alone hides it", () => {
    const hidden: Record<string, AccountStanding> = {
      registered: as("registered", null, null),
      active: as("shadow_banned", null, null),
      paused: as("paused", "shadow_banned", null),
    };
    fc.assert(
      fc.property(baseArb, fc.array(openArb, { maxLength: 8 }), (base, steps) => {
        const after = through(base, steps);
        expect(strip(settle(after, NOTHING))).toEqual(base);
        expect(strip(settle(after, { ...NOTHING, shadowBan: true }))).toEqual(hidden[base.state]);
      }),
      SEEDED,
    );
  });
});

// ---------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------

/** An identity and an account in exactly the given state, with no session (none locks its row). */
async function accountIn(
  db: Queryable,
  s: Partial<AccountStanding> & { stateChangedAt?: Date | null } = {},
): Promise<{ accountId: string; identityId: string }> {
  const who = randomBytes(6).toString("hex");
  const hetuHmac = createHash("sha256").update(`kuutti test standing: ${who}`).digest("hex");
  const identity = await db.query<{ id: string }>(
    "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
    [hetuHmac],
  );
  const identityId = identity.rows[0]?.id;
  if (!identityId) throw new Error("test identity not written");
  const account = await db.query<{ id: string }>(
    `INSERT INTO account (identity_id, state, paused_from, sanctioned_from, state_changed_at, birth_year, birth_month)
     VALUES ($1, $2, $3, $4, $5, 1990, 6) RETURNING id`,
    [
      identityId,
      s.state ?? "active",
      s.pausedFrom ?? null,
      s.sanctionedFrom ?? null,
      s.stateChangedAt === undefined ? T0 : s.stateChangedAt,
    ],
  );
  const accountId = account.rows[0]?.id;
  if (!accountId) throw new Error("test account not written");
  return { accountId, identityId };
}

async function accountRow(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{
    state: AccountState;
    paused_from: AccountState | null;
    sanctioned_from: AccountState | null;
    state_changed_at: Date | null;
  }>("SELECT state, paused_from, sanctioned_from, state_changed_at FROM account WHERE id = $1", [
    accountId,
  ]);
  return rows[0];
}

async function identityRow(ctx: TestContext, identityId: string) {
  const { rows } = await ctx.client.query<{
    standing: IdentityStanding;
    standing_changed_at: Date | null;
    suspension_ends_at: Date | null;
  }>("SELECT standing, standing_changed_at, suspension_ends_at FROM identity WHERE id = $1", [
    identityId,
  ]);
  return rows[0];
}

/** The caller's connection, with every statement it runs written down. */
function recording(db: Queryable): Queryable & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      statements.push(text);
      return db.query<R>(text, values);
    },
  };
}

const at = (iso: string) => new Date(iso);
const open = (o: Partial<OpenSanctions> = {}): OpenSanctions => ({ ...NOTHING, ...o });

describe("lockAccountForSanction", () => {
  test("answers null for an account that does not exist", async ({ ctx }) => {
    expect(
      await lockAccountForSanction(ctx.client, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });

  test("returns the account's identity and state", async ({ ctx }) => {
    const a = await accountIn(ctx.client, { state: "paused", pausedFrom: "active" });
    expect(await lockAccountForSanction(ctx.client, a.accountId)).toEqual({
      identityId: a.identityId,
      state: "paused",
      accounts: [{ id: a.accountId, state: "paused" }],
    });
  });

  test("returns a tombstone, whose identity a ban still binds", async ({ ctx }) => {
    const a = await accountIn(ctx.client, { state: "deleted" });
    expect(await lockAccountForSanction(ctx.client, a.accountId)).toEqual({
      identityId: a.identityId,
      state: "deleted",
      accounts: [{ id: a.accountId, state: "deleted" }],
    });
  });

  test("returns and locks every account of the identity in id order, the target's state beside them", async ({
    ctx,
  }) => {
    const a = await accountIn(ctx.client, { state: "deleted" });
    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO account (identity_id, state, birth_year, birth_month)
       VALUES ($1, 'active', 1990, 1) RETURNING id`,
      [a.identityId],
    );
    const live = rows[0]?.id as string;
    const locked = await lockAccountForSanction(ctx.client, a.accountId);
    expect(locked?.state).toBe("deleted");
    expect(locked?.accounts).toEqual(
      [
        { id: a.accountId, state: "deleted" },
        { id: live, state: "active" },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    const { rows: lockers } = await ctx.client.query<{ locker: string; me: string }>(
      `SELECT xmax::text AS locker, txid_current()::text AS me FROM account WHERE identity_id = $1
       UNION ALL SELECT xmax::text, txid_current()::text FROM identity WHERE id = $1`,
      [a.identityId],
    );
    expect(lockers.every((row) => row.locker === row.me)).toBe(true);
  });

  test("locks the account row in the caller's transaction", async ({ ctx }) => {
    const a = await accountIn(ctx.client);
    const lockedBy = async () => {
      const { rows } = await ctx.client.query<{ locker: string; me: string }>(
        "SELECT xmax::text AS locker, txid_current()::text AS me FROM account WHERE id = $1",
        [a.accountId],
      );
      return rows[0];
    };
    expect((await lockedBy())?.locker).toBe("0");
    await lockAccountForSanction(ctx.client, a.accountId);
    const after = await lockedBy();
    expect(after?.locker).toBe(after?.me);
  });
});

describe("settleStanding", () => {
  test("answers an account that does not exist with an error and writes nothing", async ({
    ctx,
  }) => {
    const db = recording(ctx.client);
    await expect(
      settleStanding(db, {
        accountId: "00000000-0000-4000-8000-000000000000",
        open: open(),
        at: T,
      }),
    ).rejects.toThrow("settleStanding: no account 00000000-0000-4000-8000-000000000000");
    expect(db.statements.filter((s) => /^\s*UPDATE/.test(s))).toEqual([]);
  });

  test("returns what it settled to", async ({ ctx }) => {
    const a = await accountIn(ctx.client, { state: "paused", pausedFrom: "active" });
    expect(
      await settleStanding(ctx.client, {
        accountId: a.accountId,
        open: open({ suspensionEndsAt: ENDS, shadowBan: true }),
        at: T,
      }),
    ).toEqual({
      state: "suspended",
      pausedFrom: "active",
      sanctionedFrom: "paused",
      standing: "suspended",
      suspensionEndsAt: ENDS,
    });
  });

  test("the standing's date moves only when the standing does, and the suspension's end with it", async ({
    ctx,
  }) => {
    const a = await accountIn(ctx.client);
    const settleAt = (iso: string, o: Partial<OpenSanctions>) =>
      settleStanding(ctx.client, { accountId: a.accountId, open: open(o), at: at(iso) });

    // Nothing open on an identity in good standing: nothing moves.
    await settleAt("2026-10-20T09:00:00Z", {});
    expect(await identityRow(ctx, a.identityId)).toEqual({
      standing: "ok",
      standing_changed_at: null,
      suspension_ends_at: null,
    });

    // A shadow ban is not a standing.
    await settleAt("2026-10-20T09:30:00Z", { shadowBan: true });
    expect((await identityRow(ctx, a.identityId))?.standing_changed_at).toBeNull();

    await settleAt("2026-10-20T10:00:00Z", { suspensionEndsAt: ENDS });
    expect(await identityRow(ctx, a.identityId)).toEqual({
      standing: "suspended",
      standing_changed_at: at("2026-10-20T10:00:00Z"),
      suspension_ends_at: ENDS,
    });

    // A second, longer suspension: still suspended since 10:00, until the later day.
    const later = at("2026-10-29T22:00:00Z");
    await settleAt("2026-10-20T11:00:00Z", { suspensionEndsAt: later });
    expect(await identityRow(ctx, a.identityId)).toEqual({
      standing: "suspended",
      standing_changed_at: at("2026-10-20T10:00:00Z"),
      suspension_ends_at: later,
    });

    // A ban over the suspension: banned from now, no end to name.
    await settleAt("2026-10-20T12:00:00Z", { ban: true, suspensionEndsAt: later });
    expect(await identityRow(ctx, a.identityId)).toEqual({
      standing: "banned",
      standing_changed_at: at("2026-10-20T12:00:00Z"),
      suspension_ends_at: null,
    });

    // The ban lifted while the suspension stands: suspended again, until its day.
    await settleAt("2026-10-20T13:00:00Z", { suspensionEndsAt: later });
    expect(await identityRow(ctx, a.identityId)).toEqual({
      standing: "suspended",
      standing_changed_at: at("2026-10-20T13:00:00Z"),
      suspension_ends_at: later,
    });

    await settleAt("2026-10-30T01:00:00Z", {});
    expect(await identityRow(ctx, a.identityId)).toEqual({
      standing: "ok",
      standing_changed_at: at("2026-10-30T01:00:00Z"),
      suspension_ends_at: null,
    });
  });

  test("writes the state, paused_from and sanctioned_from, and a lift brings the break back", async ({
    ctx,
  }) => {
    const a = await accountIn(ctx.client, { state: "paused", pausedFrom: "active" });
    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open({ suspensionEndsAt: ENDS }),
      at: T,
    });
    expect(await accountRow(ctx, a.accountId)).toEqual({
      state: "suspended",
      paused_from: "active",
      sanctioned_from: "paused",
      state_changed_at: T,
    });

    // A shadow ban applied while suspended shows nowhere until the suspension ends.
    const t2 = at("2026-10-21T08:00:00Z");
    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open({ suspensionEndsAt: ENDS, shadowBan: true }),
      at: t2,
    });
    expect(await accountRow(ctx, a.accountId)).toEqual({
      state: "suspended",
      paused_from: "active",
      sanctioned_from: "paused",
      state_changed_at: T,
    });

    const t3 = at("2026-10-22T01:00:00Z");
    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open({ shadowBan: true }),
      at: t3,
    });
    expect(await accountRow(ctx, a.accountId)).toEqual({
      state: "paused",
      paused_from: "shadow_banned",
      sanctioned_from: null,
      state_changed_at: t3,
    });
  });

  test("a shadow ban and its lift move no date the person can read", async ({ ctx }) => {
    const a = await accountIn(ctx.client);
    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open({ shadowBan: true }),
      at: T,
    });
    expect(await accountRow(ctx, a.accountId)).toEqual({
      state: "shadow_banned",
      paused_from: null,
      sanctioned_from: null,
      state_changed_at: T0,
    });

    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open(),
      at: at("2026-10-21T09:00:00Z"),
    });
    expect(await accountRow(ctx, a.accountId)).toEqual({
      state: "active",
      paused_from: null,
      sanctioned_from: null,
      state_changed_at: T0,
    });
  });

  test("a shadow ban on a break or before the activation moves no date either", async ({ ctx }) => {
    const paused = await accountIn(ctx.client, { state: "paused", pausedFrom: "active" });
    const registered = await accountIn(ctx.client, { state: "registered" });
    for (const id of [paused.accountId, registered.accountId]) {
      await settleStanding(ctx.client, { accountId: id, open: open({ shadowBan: true }), at: T });
    }
    expect(await accountRow(ctx, paused.accountId)).toEqual({
      state: "paused",
      paused_from: "shadow_banned",
      sanctioned_from: null,
      state_changed_at: T0,
    });
    expect(await accountRow(ctx, registered.accountId)).toEqual({
      state: "registered",
      paused_from: null,
      sanctioned_from: null,
      state_changed_at: T0,
    });
  });

  test("a suspension and its end move the state's date, under a shadow ban too", async ({
    ctx,
  }) => {
    const a = await accountIn(ctx.client, { state: "shadow_banned" });
    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open({ suspensionEndsAt: ENDS, shadowBan: true }),
      at: T,
    });
    expect(await accountRow(ctx, a.accountId)).toEqual({
      state: "suspended",
      paused_from: null,
      sanctioned_from: "active",
      state_changed_at: T,
    });

    // A ban over the suspension: the person sees a change, so the date moves.
    const t2 = at("2026-10-21T09:00:00Z");
    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open({ ban: true, suspensionEndsAt: ENDS, shadowBan: true }),
      at: t2,
    });
    expect(await accountRow(ctx, a.accountId)).toMatchObject({
      state: "banned",
      sanctioned_from: "active",
      state_changed_at: t2,
    });

    const t3 = at("2026-10-22T01:00:00Z");
    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open({ shadowBan: true }),
      at: t3,
    });
    expect(await accountRow(ctx, a.accountId)).toEqual({
      state: "shadow_banned",
      paused_from: null,
      sanctioned_from: null,
      state_changed_at: t3,
    });
  });

  test("settling what is already settled moves no date", async ({ ctx }) => {
    const a = await accountIn(ctx.client);
    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open({ suspensionEndsAt: ENDS }),
      at: T,
    });
    await settleStanding(ctx.client, {
      accountId: a.accountId,
      open: open({ suspensionEndsAt: ENDS }),
      at: at("2026-10-21T01:00:00Z"),
    });
    expect((await accountRow(ctx, a.accountId))?.state_changed_at).toEqual(T);
    expect((await identityRow(ctx, a.identityId))?.standing_changed_at).toEqual(T);
  });

  test("a ban on a tombstone sets the identity's standing and never writes the state", async ({
    ctx,
  }) => {
    const a = await accountIn(ctx.client, { state: "deleted" });
    const db = recording(ctx.client);
    const settled = await settleStanding(db, {
      accountId: a.accountId,
      open: open({ ban: true }),
      at: T,
    });
    expect(settled).toEqual({
      state: "deleted",
      pausedFrom: null,
      sanctionedFrom: null,
      standing: "banned",
      suspensionEndsAt: null,
    });
    expect(db.statements.filter((s) => /UPDATE\s+account\b/.test(s))).toEqual([]);
    expect(await accountRow(ctx, a.accountId)).toEqual({
      state: "deleted",
      paused_from: null,
      sanctioned_from: null,
      state_changed_at: T0,
    });
    expect(await identityRow(ctx, a.identityId)).toEqual({
      standing: "banned",
      standing_changed_at: T,
      suspension_ends_at: null,
    });
  });

  test("the night's end of a suspension kept through an erasure clears the tombstone's identity", async ({
    ctx,
  }) => {
    const a = await accountIn(ctx.client, { state: "deleted" });
    await ctx.client.query(
      "UPDATE identity SET standing = 'suspended', standing_changed_at = $2, suspension_ends_at = $3 WHERE id = $1",
      [a.identityId, T0, ENDS],
    );
    const t = at("2026-10-22T01:00:00Z");
    await settleStanding(ctx.client, { accountId: a.accountId, open: open(), at: t });
    expect(await identityRow(ctx, a.identityId)).toEqual({
      standing: "ok",
      standing_changed_at: t,
      suspension_ends_at: null,
    });
    expect((await accountRow(ctx, a.accountId))?.state).toBe("deleted");
  });

  test("settles only the account named, not another account of the same identity", async ({
    ctx,
  }) => {
    const live = await accountIn(ctx.client);
    const { rows } = await ctx.client.query<{ id: string }>(
      "INSERT INTO account (identity_id, state, state_changed_at) VALUES ($1, 'deleted', $2) RETURNING id",
      [live.identityId, T0],
    );
    const tombstone = rows[0]?.id ?? "";
    await settleStanding(ctx.client, {
      accountId: live.accountId,
      open: open({ suspensionEndsAt: ENDS }),
      at: T,
    });
    expect((await accountRow(ctx, live.accountId))?.state).toBe("suspended");
    expect(await accountRow(ctx, tombstone)).toEqual({
      state: "deleted",
      paused_from: null,
      sanctioned_from: null,
      state_changed_at: T0,
    });
  });
});

describe("endSessionsForSanction", () => {
  async function adminSession(db: Queryable, identityId: string, revokedAt: Date | null = null) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO admin_session (identity_id, role, access_hash, expires_at, revoked_at)
       VALUES ($1, 'moderator', $2, $3, $4) RETURNING id`,
      [
        identityId,
        hashToken(randomBytes(32).toString("base64url")),
        at("2026-10-20T17:00:00Z"),
        revokedAt,
      ],
    );
    return rows[0]?.id ?? "";
  }

  /** One signed-in device of the account, as `signInAs` writes it, with its id. */
  async function sessionOf(db: Queryable, accountId: string) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, expires_at)
       VALUES ($1, 'ios', $2, $3, $4, $5) RETURNING id`,
      [
        accountId,
        hashToken(randomBytes(32).toString("base64url")),
        at("2026-10-20T09:15:00Z"),
        hashToken(randomBytes(32).toString("base64url")),
        at("2027-01-18T09:00:00Z"),
      ],
    );
    return rows[0]?.id ?? "";
  }

  async function sessions(ctx: TestContext, accountId: string) {
    const { rows } = await ctx.client.query<{
      id: string;
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>("SELECT id, revoked_at, revoked_reason FROM session WHERE account_id = $1 ORDER BY id", [
      accountId,
    ]);
    return rows;
  }

  async function adminSessions(ctx: TestContext, identityId: string) {
    const { rows } = await ctx.client.query<{ id: string; revoked_at: Date | null }>(
      "SELECT id, revoked_at FROM admin_session WHERE identity_id = $1 ORDER BY id",
      [identityId],
    );
    return rows;
  }

  test("revokes the account's live sessions for the sanction and the identity's panel sessions, and counts them", async ({
    ctx,
  }) => {
    const a = await accountIn(ctx.client);
    const first = await sessionOf(ctx.client, a.accountId);
    const second = await sessionOf(ctx.client, a.accountId);
    const signedOut = await sessionOf(ctx.client, a.accountId);
    await ctx.client.query(
      "UPDATE session SET revoked_at = $2, revoked_reason = 'logout' WHERE id = $1",
      [signedOut, T0],
    );
    const panel = await adminSession(ctx.client, a.identityId);
    const panelEnded = await adminSession(ctx.client, a.identityId, T0);

    // Somebody else's sessions, which the sanction must not touch.
    const other = await accountIn(ctx.client);
    const otherSession = await sessionOf(ctx.client, other.accountId);
    const otherPanel = await adminSession(ctx.client, other.identityId);

    expect(
      await endSessionsForSanction(ctx.client, {
        accountIds: [a.accountId],
        identityId: a.identityId,
        at: T,
      }),
    ).toEqual({ sessions: 2, adminSessions: 1 });

    const byId = new Map((await sessions(ctx, a.accountId)).map((s) => [s.id, s]));
    expect(byId.get(first)).toMatchObject({ revoked_at: T, revoked_reason: "sanction" });
    expect(byId.get(second)).toMatchObject({ revoked_at: T, revoked_reason: "sanction" });
    expect(byId.get(signedOut)).toMatchObject({ revoked_at: T0, revoked_reason: "logout" });

    const panels = new Map((await adminSessions(ctx, a.identityId)).map((s) => [s.id, s]));
    expect(panels.get(panel)?.revoked_at).toEqual(T);
    expect(panels.get(panelEnded)?.revoked_at).toEqual(T0);

    expect(await sessions(ctx, other.accountId)).toEqual([
      { id: otherSession, revoked_at: null, revoked_reason: null },
    ]);
    expect(await adminSessions(ctx, other.identityId)).toEqual([
      { id: otherPanel, revoked_at: null },
    ]);
  });

  test("with no live account ends only the identity's panel sessions", async ({ ctx }) => {
    const a = await accountIn(ctx.client);
    const device = await sessionOf(ctx.client, a.accountId);
    const panel = await adminSession(ctx.client, a.identityId);

    expect(
      await endSessionsForSanction(ctx.client, {
        accountIds: [],
        identityId: a.identityId,
        at: T,
      }),
    ).toEqual({ sessions: 0, adminSessions: 1 });
    expect(await sessions(ctx, a.accountId)).toEqual([
      { id: device, revoked_at: null, revoked_reason: null },
    ]);
    expect(await adminSessions(ctx, a.identityId)).toEqual([{ id: panel, revoked_at: T }]);
  });

  test("counts nothing when nothing is live", async ({ ctx }) => {
    const a = await accountIn(ctx.client);
    expect(
      await endSessionsForSanction(ctx.client, {
        accountIds: [a.accountId],
        identityId: a.identityId,
        at: T,
      }),
    ).toEqual({ sessions: 0, adminSessions: 0 });
  });

  test("a second call revokes nothing more and keeps the first one's time", async ({ ctx }) => {
    const a = await accountIn(ctx.client);
    const device = await sessionOf(ctx.client, a.accountId);
    const panel = await adminSession(ctx.client, a.identityId);
    await endSessionsForSanction(ctx.client, {
      accountIds: [a.accountId],
      identityId: a.identityId,
      at: T,
    });
    expect(
      await endSessionsForSanction(ctx.client, {
        accountIds: [a.accountId],
        identityId: a.identityId,
        at: at("2026-10-21T09:00:00Z"),
      }),
    ).toEqual({ sessions: 0, adminSessions: 0 });
    expect(await sessions(ctx, a.accountId)).toEqual([
      { id: device, revoked_at: T, revoked_reason: "sanction" },
    ]);
    expect(await adminSessions(ctx, a.identityId)).toEqual([{ id: panel, revoked_at: T }]);
  });
});
