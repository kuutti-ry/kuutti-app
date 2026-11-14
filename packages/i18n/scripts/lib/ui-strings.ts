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
  "children",
  "confirmLabel",
  "message",
  "helperText",
  "aria-description",
  "aria-valuetext",
]);

// Punctuation, digits and symbols ("✓", "·", "…") are not language.
const HAS_LETTER = /\p{L}/u;

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
    const decoded = text
      .replace(/&#(x[\da-f]+|\d+);/gi, (_match, number: string) =>
        String.fromCodePoint(
          Number.parseInt(number.replace(/^x/i, ""), /^x/i.test(number) ? 16 : 10),
        ),
      )
      .replace(/&(amp|lt|gt|quot|apos|nbsp|middot|hellip|ndash|mdash|copy|reg|trade);/g, " ");
    if (!HAS_LETTER.test(decoded)) return;
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push({ line: line + 1, column: character + 1, text: text.trim(), where });
  };

  const literal = (node: ts.Expression, where: string): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      report(node, node.text, where);
    else if (ts.isTemplateExpression(node)) {
      report(
        node,
        [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(""),
        where,
      );
      for (const span of node.templateSpans) literal(span.expression, where);
    } else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      literal(node.expression, where);
    else if (ts.isConditionalExpression(node)) {
      literal(node.whenTrue, where);
      literal(node.whenFalse, where);
    } else if (ts.isBinaryExpression(node)) {
      if (
        ![
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind)
      )
        return;
      // The condition of && is not displayed; its right side is.
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
        literal(node.left, where);
      literal(node.right, where);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) if (ts.isExpression(element)) literal(element, where);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      [
        "join",
        "concat",
        "trim",
        "toUpperCase",
        "toLowerCase",
        "slice",
        "substring",
        "replace",
      ].includes(node.expression.name.text)
    ) {
      // ["One", "Two"].join(): its receiver supplies the displayed words.
      // Arguments to t(), formatDate() etc. are keys/options, not words.
      literal(node.expression.expression, where);
    }
  };
  const objectText = (node: ts.Expression): void => {
    if (!ts.isObjectLiteralExpression(node)) return;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : "";
      if (TEXT_PROPS.has(name) || name === "text") literal(property.initializer, `${name} prop`);
      else if (name === "options" || name === "accessibilityValue")
        objectText(property.initializer);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      report(node, node.text, "text between tags");
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      literal(node.expression, "literal as a child");
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(file);
      if (TEXT_PROPS.has(name)) {
        if (ts.isJsxExpression(node.initializer) && node.initializer.expression)
          literal(node.initializer.expression, `${name} prop`);
        else if (ts.isStringLiteral(node.initializer))
          report(node, node.initializer.text, `${name} prop`);
      } else if (
        (name === "options" || name === "accessibilityValue") &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      ) {
        objectText(node.initializer.expression);
      }
    } else if (ts.isJsxSpreadAttribute(node)) objectText(node.expression);
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["Alert.alert", "AccessibilityInfo.announceForAccessibility"].includes(
        node.expression.getText(file),
      )
    ) {
      for (const argument of node.arguments) literal(argument, "spoken or displayed text");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
