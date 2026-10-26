/** Preserve module URL resolution when modules are delivered by a query proxy. */
export async function rewritePreviewModule(source: string, resolve: (url: string) => string): Promise<string> {
  const ts = await import('typescript');
  const file = ts.createSourceFile('preview.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const rewrite = (node: import('typescript').Node | undefined) => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    if (!node.text.startsWith('.') && !node.text.startsWith('/') && !URL.canParse(node.text)) return;
    const url = resolve(node.text);
    if (url !== node.text) edits.push({ start: node.getStart(file), end: node.end, text: JSON.stringify(url) });
  };
  const visit = (node: import('typescript').Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) rewrite(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) rewrite(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}
