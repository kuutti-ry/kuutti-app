import ts from "typescript";

export type UiString = { line: number; column: number; text: string; where: string };

// Props whose value a person reads or hears. A literal there is an inline string.
const TEXT_PROPS = new Set([
  "accessibilityLabel",
  "accessibilityHint",
  "aria-label",
  "placeholder",
  "title",
  "alt",
  "label",
  "closeLabel",
]);

// Punctuation, digits and symbols ("✓", "·", "…") are not language.
const HAS_LETTER = /\p{L}/u;

function literalText(node: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  if (ts.isConditionalExpression(node)) {
    return `${literalText(node.whenTrue) ?? ""}${literalText(node.whenFalse) ?? ""}`;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return literalText(node.right);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("");
  }
  return undefined;
}

/**
 * User-facing string literals in a TSX file (CLAUDE.md Code: strings go
 * through i18n keys, never inline): text between tags, a literal as a JSX
 * child, and a literal in a prop that is read or heard.
 */
export function findUiStrings(fileName: string, source: string): UiString[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: UiString[] = [];
  const report = (node: ts.Node, text: string, where: string): void => {
    if (!HAS_LETTER.test(text)) return;
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push({ line: line + 1, column: character + 1, text: text.trim(), where });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      report(node, node.text, "text between tags");
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const text = literalText(node.expression);
      if (text !== undefined) report(node, text, "literal as a child");
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(file);
      if (TEXT_PROPS.has(name)) {
        const value = ts.isJsxExpression(node.initializer)
          ? node.initializer.expression && literalText(node.initializer.expression)
          : ts.isStringLiteral(node.initializer)
            ? node.initializer.text
            : undefined;
        if (value !== undefined) report(node, value, `${name} prop`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
