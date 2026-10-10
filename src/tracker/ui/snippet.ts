/** Render server-provided search snippets without interpreting HTML. Only balanced exact markers are formatting. */
export function renderSnippet(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('<mark>', cursor);
    const close = text.indexOf('</mark>', cursor);
    const next = [open, close].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    if (next === undefined) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
      break;
    }
    if (next > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, next)));
    if (next === close) {
      fragment.appendChild(document.createTextNode('</mark>'));
      cursor = close + '</mark>'.length;
      continue;
    }

    const contentStart = open + '<mark>'.length;
    const nextOpen = text.indexOf('<mark>', contentStart);
    const contentEnd = text.indexOf('</mark>', contentStart);
    if (contentEnd < 0 || (nextOpen >= 0 && nextOpen < contentEnd)) {
      fragment.appendChild(document.createTextNode('<mark>'));
      cursor = contentStart;
      continue;
    }
    const mark = document.createElement('mark');
    mark.appendChild(document.createTextNode(text.slice(contentStart, contentEnd)));
    fragment.appendChild(mark);
    cursor = contentEnd + '</mark>'.length;
  }
  return fragment;
}
