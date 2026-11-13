import { attackFails, attackWith, holeStands } from "../../../../scripts/lib/attack";

const claim = (seen: boolean) => expect(seen).toBe(true);
const control = () => true;

describe("the attack helper on jest-expo", () => {
  it("recognizes a real Jest matcher failure as a refused violation", async () => {
    await expect(
      attackFails("refused", { attempt: () => false, control, succeeds: claim }),
    ).resolves.toBeUndefined();
  });

  it("fails a violation whose real Jest assertion holds", async () => {
    await expect(
      attackFails("accepted", { attempt: control, control, succeeds: claim }),
    ).rejects.toThrow("the rule was broken: accepted");
  });

  it.each([false, true])("awaits the attempt and Jest's async assertion (%s)", async (accepted) => {
    const result = attackFails("async", {
      attempt: async () => accepted,
      control,
      succeeds: async (seen) => {
        await expect(Promise.resolve(seen)).resolves.toBe(true);
      },
    });
    if (accepted) await expect(result).rejects.toThrow("the rule was broken: async");
    else await expect(result).resolves.toBeUndefined();
  });

  it("does not mistake a Jest assertion in setup for a refused violation", async () => {
    let broken: unknown;
    try {
      expect("wrong fixture").toBe("ready");
    } catch (error) {
      broken = error;
    }
    expect(broken).toBeInstanceOf(Error);
    await expect(
      attackFails("setup", {
        attempt: () => {
          throw broken;
        },
        control,
        succeeds: claim,
      }),
    ).rejects.toBe(broken);
  });

  it("rethrows a rejected attempt and a non-assertion error from the claim", async () => {
    const broken = new TypeError("broken fixture");
    await expect(
      attackFails("attempt", {
        attempt: async () => {
          throw broken;
        },
        control,
        succeeds: claim,
      }),
    ).rejects.toBe(broken);
    await expect(
      attackFails("claim", {
        attempt: control,
        control,
        succeeds: () => {
          throw broken;
        },
      }),
    ).rejects.toBe(broken);
  });

  it("runs an open hole and reports when that same hole closes", async () => {
    await expect(
      holeStands("open", { attempt: control, control, succeeds: claim }),
    ).resolves.toBeUndefined();
    await expect(
      holeStands("closed", { attempt: () => false, control, succeeds: claim }),
    ).rejects.toThrow("this hole is closed");
    const broken = new Error("unexpected rejection");
    await expect(
      holeStands("broken", {
        attempt: async () => {
          throw broken;
        },
        control,
        succeeds: claim,
      }),
    ).rejects.toBe(broken);
  });

  it.each([undefined, "#380"])(
    "registers and executes the control even for an open mark (%s)",
    async (open) => {
      const registered: { name: string; run: () => Promise<void> }[] = [];
      const register = attackWith((name, run) => {
        registered.push({ name, run });
      });
      const positive = jest.fn(() => true);
      register("binding", {
        attempt: () => open !== undefined,
        control: positive,
        succeeds: claim,
        open,
      });
      expect(registered.map(({ name }) => name)).toEqual([
        "control: binding",
        open === undefined ? "attack: binding" : "attack (open #380): binding",
      ]);
      for (const test of registered) await test.run();
      expect(positive).toHaveBeenCalledTimes(1);
    },
  );

  it("fails a broken control with Jest's original matcher error", async () => {
    const runs: (() => Promise<void>)[] = [];
    attackWith((_name, run) => {
      runs.push(run);
    })("control", {
      attempt: () => false,
      control: () => false,
      succeeds: claim,
    });
    await expect(runs[0]?.()).rejects.toMatchObject({ matcherResult: expect.any(Object) });
  });
});
