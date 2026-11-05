import { rewardParams } from "./words";

// What an invitation earns as the messages' arguments (#107, #503): which of
// the two sides earn picks the sentence, zero on a side switching it off, and
// the numbers go with it as they are.

describe("rewardParams", () => {
  it.each([
    [{ inviterFish: 1, friendFish: 1 }, "both"],
    [{ inviterFish: 2, friendFish: 3 }, "both"],
    [{ inviterFish: 10, friendFish: 10 }, "both"],
    [{ inviterFish: 1, friendFish: 0 }, "inviter"],
    [{ inviterFish: 10, friendFish: 0 }, "inviter"],
    [{ inviterFish: 0, friendFish: 1 }, "friend"],
    [{ inviterFish: 0, friendFish: 10 }, "friend"],
    [{ inviterFish: 0, friendFish: 0 }, "none"],
  ])("words %j as %s", (fish, reward) => {
    expect(rewardParams(fish)).toEqual({ reward, ...fish });
  });
});
