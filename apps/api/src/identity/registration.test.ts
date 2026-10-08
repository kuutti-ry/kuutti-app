import type { Account, Identity } from "@kuutti/db";
import { describe, expect, it } from "vitest";
import { decideRegistration, REREGISTER_COOLDOWN_DAYS, recordDeletion } from "./registration.ts";

// features/identity/re-registration.feature (ADR-002): scenario names verbatim.

const now = new Date("2026-10-01T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function identityRow(overrides: Partial<Identity> = {}): Identity {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    hetuHmac: "a".repeat(64),
    standing: "ok",
    standingChangedAt: null,
    brokerSubject: null,
    brokerSessionIndex: null,
    brokerTokenId: null,
    authenticatedAt: null,
    acr: null,
    amr: null,
    deletionCount: 0,
    reregisterAfter: null,
    refusedAttempts: 0,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

function accountRow(identityId: string): Account {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    identityId,
    state: "active",
    stateChangedAt: null,
    birthYear: 1990,
    birthMonth: 1,
    registeredAt: new Date("2026-09-01T00:00:00Z"),
    gender: null,
    pondId: null,
    genderChangedAt: null,
    seeksChangedAt: null,
    email: null,
    deletedAt: null,
  };
}

describe("Re-registration after deletion or ban", () => {
  it("A banned identity cannot come back", () => {
    const decision = decideRegistration({
      identity: identityRow({ standing: "banned" }),
      liveAccount: null,
      now,
    });
    expect(decision).toEqual({ kind: "refuse", reason: "banned" });
  });

  it("A suspended identity waits", () => {
    expect(
      decideRegistration({
        identity: identityRow({ standing: "suspended" }),
        liveAccount: null,
        now,
      }),
    ).toEqual({ kind: "refuse", reason: "suspended" });
  });

  describe("Deletion cooldown", () => {
    it.each([
      { days: 0, outcome: "refused" },
      { days: 29, outcome: "refused" },
      { days: 30, outcome: "allowed" },
    ])("deleted $days days ago: account creation is $outcome", ({ days, outcome }) => {
      const deletedAt = new Date(now.getTime() - days * DAY_MS);
      const after = recordDeletion({ deletionCount: 0 }, deletedAt);
      const decision = decideRegistration({
        identity: identityRow({ standing: "ok", ...after }),
        liveAccount: null,
        now,
      });
      if (outcome === "refused") {
        expect(decision).toEqual({
          kind: "refuse",
          reason: "cooldown",
          until: new Date(deletedAt.getTime() + REREGISTER_COOLDOWN_DAYS * DAY_MS),
        });
      } else {
        expect(decision).toEqual({ kind: "create_account", identityId: identityRow().id });
      }
    });
  });

  it("A person the database has never seen gets an identity first", () => {
    expect(decideRegistration({ identity: null, liveAccount: null, now })).toEqual({
      kind: "create_identity",
    });
  });

  it("An identity with a live account resumes it", () => {
    const id = identityRow();
    const live = accountRow(id.id);
    expect(decideRegistration({ identity: id, liveAccount: live, now })).toEqual({
      kind: "resume",
      account: live,
    });
  });

  it("A ban outranks a live account and a cooldown outranks nothing but standing", () => {
    const id = identityRow({ standing: "banned" });
    expect(decideRegistration({ identity: id, liveAccount: accountRow(id.id), now }).kind).toBe(
      "refuse",
    );
    const cooling = identityRow({ reregisterAfter: new Date(now.getTime() + DAY_MS) });
    expect(
      decideRegistration({ identity: cooling, liveAccount: accountRow(cooling.id), now }).kind,
    ).toBe("resume");
  });

  it("recordDeletion counts and sets the cooldown", () => {
    const after = recordDeletion({ deletionCount: 2 }, now);
    expect(after.deletionCount).toBe(3);
    expect(after.reregisterAfter.getTime() - now.getTime()).toBe(REREGISTER_COOLDOWN_DAYS * DAY_MS);
  });
});
