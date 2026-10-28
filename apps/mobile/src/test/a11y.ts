import { StyleSheet } from "react-native";
import { TOUCH_TARGET } from "@/theme/a11y";

/** The JSON tree of @testing-library/react-native's `screen.toJSON()`. */
export type HostNode = {
  type: string;
  props: Record<string, unknown>;
  children: Array<HostNode | string> | null;
};

function visit(node: HostNode | string, each: (node: HostNode) => void): void {
  if (typeof node === "string") return;
  each(node);
  for (const child of node.children ?? []) visit(child, each);
}

function textOf(node: HostNode | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

/** Everything a finger can activate: host views wired for presses, and text inputs. */
export function pressables(tree: HostNode | HostNode[] | null): HostNode[] {
  const found: HostNode[] = [];
  for (const root of Array.isArray(tree) ? tree : tree ? [tree] : []) {
    visit(root, (node) => {
      const pressable =
        typeof node.props.onClick === "function" ||
        typeof node.props.onResponderRelease === "function";
      // accessible={false} takes a view out of the accessibility tree: a screen
      // reader cannot land on it, so it needs no role or label (the Label's
      // press wrapper, the dialog's scrim). Whatever it wraps is still checked.
      if (node.props.accessible === false) return;
      if (pressable || node.type === "TextInput") found.push(node);
    });
  }
  return found;
}

function edge(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * What the accessibility baseline (CLAUDE.md) finds wrong with one pressable:
 * no role, no label and no text to fall back on, or a touch target under 44 pt
 * counting hitSlop. Empty when it is fine.
 */
export function a11yProblems(node: HostNode): string[] {
  const problems: string[] = [];
  const props = node.props;

  if (node.type !== "TextInput" && !props.accessibilityRole && !props.role) {
    problems.push("no accessibilityRole");
  }

  const label = props.accessibilityLabel ?? props["aria-label"];
  if (!(typeof label === "string" && label.length > 0) && textOf(node).trim().length === 0) {
    problems.push("no accessibilityLabel and no text");
  }

  const style = (StyleSheet.flatten(props.style as never) ?? {}) as Record<string, unknown>;
  const slop = (
    typeof props.hitSlop === "object" && props.hitSlop !== null ? props.hitSlop : {}
  ) as Record<string, unknown>;
  const uniform = typeof props.hitSlop === "number" ? props.hitSlop : 0;
  const width =
    Math.max(edge(style.width), edge(style.minWidth)) +
    (uniform * 2 || edge(slop.left) + edge(slop.right));
  const height =
    Math.max(edge(style.height), edge(style.minHeight)) +
    (uniform * 2 || edge(slop.top) + edge(slop.bottom));
  if (node.type !== "TextInput" && (width < TOUCH_TARGET || height < TOUCH_TARGET)) {
    problems.push(`touch target ${width}x${height} pt, needs ${TOUCH_TARGET}x${TOUCH_TARGET}`);
  }
  return problems;
}

/** The nodes hidden from a screen reader: what a decorative icon, glyph or mark renders as. */
export function hiddenNodes(tree: HostNode | HostNode[] | null): HostNode[] {
  const found: HostNode[] = [];
  for (const root of Array.isArray(tree) ? tree : tree ? [tree] : []) {
    visit(root, (node) => {
      if (node.props.accessibilityElementsHidden === true) found.push(node);
    });
  }
  return found;
}

/**
 * Whether a decorative node comes just before the text of these words, as a
 * mark before a name (#474): false when the node before it is not hidden or
 * there is none, null when no text node holds the words.
 */
export function markBefore(tree: HostNode | HostNode[] | null, words: string): boolean | null {
  for (const root of Array.isArray(tree) ? tree : tree ? [tree] : []) {
    let found: boolean | null = null;
    visit(root, (node) => {
      if (found !== null) return;
      const kids = node.children ?? [];
      const at = kids.findIndex(
        (kid) => typeof kid !== "string" && kid.type === "Text" && textOf(kid) === words,
      );
      if (at < 0) return;
      const before = kids[at - 1];
      found =
        before !== undefined && hiddenNodes(typeof before === "string" ? null : before).length > 0;
    });
    if (found !== null) return found;
  }
  return null;
}
