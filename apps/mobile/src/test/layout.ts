import { screen } from "@testing-library/react-native";
import type { HostNode } from "./a11y";

function each(node: HostNode | string, visit: (node: HostNode) => void): void {
  if (typeof node === "string") return;
  visit(node);
  for (const child of node.children ?? []) each(child, visit);
}

/** The texts and the screen-reader labels inside a tree, for asking where something is. */
function wordsIn(node: HostNode): string[] {
  const words: string[] = [];
  each(node, (inner) => {
    const label = inner.props.accessibilityLabel;
    if (typeof label === "string") words.push(label);
    for (const child of inner.children ?? []) if (typeof child === "string") words.push(child);
  });
  return words;
}

/**
 * Whether a text is cut at the largest text size (CLAUDE.md Accessibility): a
 * fixed height, or a line count where the text does not shrink to fit its
 * lines (the header's title, #467, is never cut).
 */
export function hasCutText(tree: HostNode | HostNode[] | null): boolean {
  let cut = false;
  for (const root of Array.isArray(tree) ? tree : tree ? [tree] : []) {
    each(root, (node) => {
      if (node.type !== "Text") return;
      const style = ([] as unknown[]).concat(node.props.style ?? []) as { height?: unknown }[];
      const counted =
        node.props.numberOfLines !== undefined && node.props.adjustsFontSizeToFit !== true;
      if (counted || style.some((s) => s?.height !== undefined)) cut = true;
    });
  }
  return cut;
}

/**
 * A screen's title and its back arrow are pinned: on screen, and inside no
 * scroll view, so they stay at the top however far the content scrolls.
 */
export function expectPinnedHeader(title: string, backLabel: string): void {
  expect(screen.getByRole("heading", { name: title })).toBeTruthy();
  expect(screen.getByRole("button", { name: backLabel })).toBeTruthy();
  const tree = screen.toJSON() as HostNode | HostNode[] | null;
  const scrolls: HostNode[] = [];
  for (const root of Array.isArray(tree) ? tree : tree ? [tree] : []) {
    each(root, (node) => {
      if (node.type === "RCTScrollView") scrolls.push(node);
    });
  }
  expect(scrolls.length).toBeGreaterThan(0);
  for (const scroll of scrolls) {
    expect(wordsIn(scroll)).not.toContain(title);
    expect(wordsIn(scroll)).not.toContain(backLabel);
  }
}
