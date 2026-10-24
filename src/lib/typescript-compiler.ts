/** Shared lazy compiler for packaged AST consumers. Next externalizes this
 * dependency so its parser is shipped once, rather than in route chunks too.
 */
let compiler: Promise<typeof import('typescript')> | undefined;

export function loadTypeScriptCompiler(): Promise<typeof import('typescript')> {
  return compiler ??= import('typescript');
}
