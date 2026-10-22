import { rewardParams } from "./words";

// A reward's units as the messages' arguments (#107): which kinds there are
// picks the sentence, and the numbers go with it as they are.

describe("rewardParams", () => {
  it.each([
    [{ fish: 1, likes: 0 }, "fish"],
    [{ fish: 0, likes: 5 }, "likes"],
    [{ fish: 2, likes: 3 }, "both"],
    [{ fish: 0, likes: 0 }, "none"],
  ])("words %j as %s", (units, reward) => {
    expect(rewardParams(units)).toEqual({ reward, ...units });
  });
});
