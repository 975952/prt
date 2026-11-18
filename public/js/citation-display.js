/** Decide whether a citation would repeat the text immediately before it.
 * Inputs are visible plain text from the current prose block, never HTML or the
 * whole answer. This affects only the extra displayed quote; callers retain the
 * original fragment on the citation button for source navigation and matching.
 */
function tokens(text, { literal = false } = {}) {
  const source = String(text || '').normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    // Separate CJK characters so an introductory phrase need not end in a space.
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, ' $1 ');
  const value = literal ? source : source.toLowerCase();
  // Decimal points, apostrophes and word hyphens are meaningful. Ellipses also
  // remain: omitted words must not count as an exact adjacent quotation.
  const pattern = literal
    ? /[\p{L}\p{N}]+(?:[.'-][\p{L}\p{N}]+)*|\.{2,}|…|[^\s]/gu
    : /[\p{L}\p{N}]+(?:[.'-][\p{L}\p{N}]+)*|\.{2,}|…|[-+*/=<>^_%]|[^\s\p{P}]/gu;
  return value.match(pattern) || [];
}

export function citationAlreadyVisible(beforeText, fragmentText) {
  const fragment = String(fragmentText || '').trim();
  const before = String(beforeText || '');
  if (!fragment || !before) return false;
  // Never interpret markup as prose or join distinct paragraphs. The caller
  // extracts one visible block; this also makes accidental misuse conservative.
  if (/<\/?[a-z][^>]*>/i.test(before + fragment) || /\n\s*\n/.test(fragment)) return false;
  const adjacent = before.split(/\n\s*\n/).at(-1);
  // Formula punctuation and symbol case can change meaning. Only prose gets
  // the light punctuation/case normalization used for ordinary quotations.
  const literal = /[=+*/<>^_$]|(?:^|\s)[-−]\s*\d/.test(fragment);
  const wanted = tokens(fragment, { literal });
  const preceding = tokens(adjacent, { literal });
  if (!wanted.length || wanted.length > preceding.length) return false;
  const start = preceding.length - wanted.length;
  return wanted.every((token, index) => token === preceding[start + index]);
}

function visibleText(node) {
  const copy = node.cloneNode(true);
  copy.querySelectorAll?.('.katex-mathml, .page-ref').forEach(element => element.remove());
  return copy.textContent || '';
}

function quoteLink(reference, content) {
  const button = reference.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'citation-quote-link';
  for (const name of ['data-page', 'data-paper', 'data-fragment', 'data-unverified', 'title']) {
    if (reference.hasAttribute(name)) button.setAttribute(name, reference.getAttribute(name));
  }
  button.append(...content);
  return button;
}

/** Rendered citations are collected after each heading-delimited section.
 * The supplied HTML is already sanitized by the Markdown renderer. Run this on
 * complete answers only: streaming keeps its cheap incremental rendering path.
 */
export function compactCitationDisplay(html, { label = 'Sources' } = {}) {
  if (!String(html || '').includes('class="page-ref')) return html;
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const groups = [];
  let group = [];
  for (const node of [...holder.childNodes]) {
    if (/^H[1-6]$/.test(node.nodeName) && group.length) { groups.push(group); group = []; }
    group.push(node);
  }
  if (group.length) groups.push(group);
  for (const nodes of groups) {
    const references = nodes.flatMap(node => [...(node.querySelectorAll?.('.page-ref') || [])]);
    const sources = new Map(), quotedBlocks = new Map();
    for (const reference of references) {
      if (reference.closest('pre, code, .citation-sources')) continue;
      const block = reference.closest('p, li, blockquote, td, th');
      const fragment = reference.dataset.fragment || '';
      const inline = reference.nextElementSibling?.classList.contains('quote-inline') ? reference.nextElementSibling : null;
      if (inline && fragment) {
        const range = document.createRange();
        range.selectNodeContents(block || reference.parentElement);
        range.setEndBefore(reference);
        const before = visibleText(range.cloneContents());
        if (citationAlreadyVisible(before, fragment)) {
          inline.remove();
          if (block?.nodeName === 'P') quotedBlocks.set(block, reference);
        } else {
          const link = quoteLink(reference, [...inline.childNodes]);
          link.classList.add('quote-inline');
          inline.replaceWith(link);
        }
      }
      // A range remains one target; references to another paper never collapse
      // into the current paper even when their page numbers happen to agree.
      const end = /p\.\d+[–-](\d+)/.exec(reference.textContent || '')?.[1] || reference.dataset.page;
      const key = JSON.stringify([reference.dataset.paper || '', reference.dataset.page, end]);
      let source = sources.get(key);
      if (!source) {
        source = { button: reference.cloneNode(true), fragments: [] };
        sources.set(key, source);
      } else if ((!source.button.dataset.fragment && fragment)
        || (source.button.dataset.unverified && !reference.dataset.unverified)) {
        source.button = reference.cloneNode(true);
      }
      if (fragment && !source.fragments.includes(fragment)) source.fragments.push(fragment);
      reference.remove();
    }
    for (const [block, reference] of quotedBlocks) {
      const text = visibleText(block), fragment = reference.dataset.fragment || '';
      // A complete quoted paragraph remains directly navigable without an
      // extra page label. Do not turn mixed prose or other controls into buttons.
      if (!block.querySelector('button, a, input') && citationAlreadyVisible(text, fragment)
        && citationAlreadyVisible(fragment, text)) block.replaceChildren(quoteLink(reference, [...block.childNodes]));
    }
    if (!sources.size) continue;
    const row = document.createElement('div');
    row.className = 'citation-sources';
    const caption = document.createElement('span');
    caption.className = 'citation-sources-label'; caption.textContent = label;
    row.append(caption);
    for (const { button, fragments } of sources.values()) {
      if (fragments.length) button.dataset.fragments = JSON.stringify(fragments);
      row.append(button);
    }
    const end = nodes.at(-1);
    holder.insertBefore(row, end.nextSibling);
    for (const node of nodes) {
      if (node.nodeName === 'P' && !node.textContent.trim() && !node.querySelector('img, svg, math, .katex')) node.remove();
    }
  }
  return holder.innerHTML;
}
