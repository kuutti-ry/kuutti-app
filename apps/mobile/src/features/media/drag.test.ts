import { type Box, placed, slotAt, slotWhile } from "./drag";

// The grid's arithmetic (#179): two columns of square tiles, 100 wide, with a
// 12-point gap, laid out as the photos screen does.
const box = (column: number, row: number): Box => ({
  x: column * 112,
  y: row * 112,
  width: 100,
  height: 100,
});
const grid = [box(0, 0), box(1, 0), box(0, 1), box(1, 1), box(0, 2)];

describe("slotAt", () => {
  it.each([
    ["the top left corner", 0, 0, 0],
    ["inside the second tile", 150, 50, 1],
    ["the last point inside the first tile", 99.9, 99.9, 0],
    ["the first row of the second row", 10, 112, 2],
    ["the fifth tile, alone on its row", 50, 250, 4],
  ])("finds %s", (_, x, y, slot) => {
    expect(slotAt(grid, x, y)).toBe(slot);
  });

  it.each([
    ["the gap between the columns", 105, 50],
    ["the gap between the rows", 50, 105],
    ["beside the lone tile of the last row", 150, 250],
    ["above the grid", 50, -1],
    ["beyond the grid", 50, 400],
  ])("is null in %s", (_, x, y) => {
    expect(slotAt(grid, x, y)).toBeNull();
  });

  it("skips a tile that has not been laid out yet", () => {
    const partial: Array<Box | undefined> = [undefined, box(1, 0)];
    expect(slotAt(partial, 50, 50)).toBeNull();
    expect(slotAt(partial, 150, 50)).toBe(1);
  });

  it("is null for an empty grid", () => {
    expect(slotAt([], 0, 0)).toBeNull();
  });
});

describe("slotWhile", () => {
  it("moves the tiles between the two slots one step back when the lifted tile goes later", () => {
    // Tile 1 lifted over slot 3: tiles 2 and 3 step to 1 and 2; 0 and 4 stay.
    expect([0, 1, 2, 3, 4].map((index) => slotWhile(index, 1, 3))).toEqual([0, 3, 1, 2, 4]);
  });

  it("moves the tiles between the two slots one step forward when the lifted tile goes earlier", () => {
    // Tile 3 lifted over slot 1: tiles 1 and 2 step to 2 and 3; 0 and 4 stay.
    expect([0, 1, 2, 3, 4].map((index) => slotWhile(index, 3, 1))).toEqual([0, 2, 3, 1, 4]);
  });

  it("moves nothing while the lifted tile hovers over its own slot", () => {
    expect([0, 1, 2].map((index) => slotWhile(index, 1, 1))).toEqual([0, 1, 2]);
  });
});

describe("placed", () => {
  it.each([
    ["later", 0, 2, ["b", "c", "a", "d"]],
    ["earlier", 3, 1, ["a", "d", "b", "c"]],
    ["to the front", 2, 0, ["c", "a", "b", "d"]],
    ["where it is", 1, 1, ["a", "b", "c", "d"]],
  ])("places an item %s", (_, from, to, expected) => {
    expect(placed(["a", "b", "c", "d"], from, to)).toEqual(expected);
  });

  it("changes nothing for an item that is not there", () => {
    expect(placed(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });

  it("leaves the given list alone", () => {
    const items = ["a", "b", "c"];
    placed(items, 0, 2);
    expect(items).toEqual(["a", "b", "c"]);
  });
});
