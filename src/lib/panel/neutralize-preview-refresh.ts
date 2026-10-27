import { decodeHTMLStrict } from 'entities';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { SaxesParser } from 'saxes';

type Span = { start: number; end: number };

/** Remove declarative navigation before the browser can bypass cookie filtering. */
export function neutralizePreviewRefresh(document: string, xhtml: boolean): string {
  const spans: Span[] = [];
  if (xhtml) {
    // XML has namespaces and self-closing scripts, unlike HTML. Parse errors
    // deliberately propagate to the proxy's structured error response.
    const parser = new SaxesParser({ xmlns: true });
    // Browsers recognize the standard XHTML named entities without fetching a
    // DTD. Preserve those documents while leaving unknown XML entities refused.
    for (const [entity, name] of document.matchAll(/&([a-zA-Z][a-zA-Z0-9]+);/g)) {
      const value = decodeHTMLStrict(entity);
      if (value !== entity) parser.ENTITIES[name] = value;
    }
    const stack: Array<{ start: number; refresh: boolean }> = [];
    let start = 0;
    parser.on('opentagstart', () => { start = document.lastIndexOf('<', parser.position); });
    parser.on('opentag', tag => {
      const equivalent = tag.attributes['http-equiv'];
      stack.push({
        start,
        refresh: tag.uri === 'http://www.w3.org/1999/xhtml' && tag.local === 'meta'
          && equivalent?.value.trim().toLowerCase() === 'refresh',
      });
    });
    parser.on('closetag', () => {
      const tag = stack.pop()!;
      if (tag.refresh) spans.push({ start: tag.start, end: parser.position });
    });
    parser.write(document).close();
  } else {
    // Removing HTML can change its parse. Keep boundaries inert and only return
    // a document after a fresh parse confirms that no refresh element remains.
    for (let iteration = 0; iteration < 8; iteration++) {
      spans.length = 0;
      const visit = (node: DefaultTreeAdapterTypes.Node) => {
        if ('tagName' in node && node.tagName === 'meta'
          && node.attrs.some(attr => attr.name === 'http-equiv' && attr.value.trim().toLowerCase() === 'refresh')
          && node.sourceCodeLocation) {
          spans.push({ start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset });
        }
        if ('childNodes' in node) node.childNodes.forEach(visit);
        // Inert template content can later be inserted by the preview itself.
        if ('content' in node) visit(node.content);
      };
      visit(parse(document, { sourceCodeLocationInfo: true }));
      if (spans.length === 0) return document;
      let cursor = 0;
      let result = '';
      for (const { start, end } of spans.sort((a, b) => a.start - b.start)) {
        if (start >= cursor) result += document.slice(cursor, start) + '<!---->';
        cursor = Math.max(cursor, end);
      }
      document = result + document.slice(cursor);
    }
    // Propagate to the proxy's structured error response instead of serving an
    // unverified document when malformed HTML exhausts the parse budget.
    throw new Error('Preview refresh neutralization did not converge');
  }
  let cursor = 0;
  let result = '';
  for (const { start, end } of spans.sort((a, b) => a.start - b.start)) {
    if (start >= cursor) result += document.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return result + document.slice(cursor);
}
