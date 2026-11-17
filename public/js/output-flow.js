/** Small, conservative boundaries for streaming Markdown. No DOM or rendering dependencies. */

const LIST = /^( *)(?:[-+*]|\d+[.)])(?:[ \t]+|$)/;
const QUESTION = /^#{2,4}[ \t]+(?:第[ \t]*(\d+)[ \t]*题|[（(][ \t]*(\d+)[ \t]*[）)]|Question[ \t]+(\d+))(?:[：: \t].*)?[ \t]*$/i;
const ATX = /^ {0,3}#{1,6}(?:[ \t]+|$)/;

function indentOf(line) {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width++;
    else if (char === '\t') width += 4 - width % 4;
    else break;
  }
  return width;
}

function containerContent(line) {
  let content = line.trimStart();
  while (/^>/.test(content)) content = content.slice(1).trimStart();
  content = content.replace(/^(?:[-+*]|\d+[.)])(?:[ \t]+|$)/, '').trimStart();
  while (/^>/.test(content)) content = content.slice(1).trimStart();
  return content;
}

function openingFence(line, raw = line) {
  const match = line.match(/^(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  let prefix = raw.trimStart();
  let quoteDepth = 0;
  while (prefix.startsWith('>')) { quoteDepth++; prefix = prefix.slice(1).trimStart(); }
  const inList = /^(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.test(prefix);
  prefix = prefix.replace(/^(?:[-+*]|\d+[.)])(?:[ \t]+|$)/, '').trimStart();
  while (prefix.startsWith('>')) { quoteDepth++; prefix = prefix.slice(1).trimStart(); }
  return { char: match[1][0], length: match[1].length, quoteDepth,
    allowIndent: inList || quoteDepth > 0 || indentOf(raw) > 3 };
}

function closesFence(line, fence) {
  for (let i = 0; i < fence.quoteDepth; i++) {
    line = line.trimStart();
    if (!line.startsWith('>')) return false;
    line = line.slice(1);
  }
  if (!fence.allowIndent && indentOf(line) > 3) return false;
  const match = line.trim().match(/^(`{3,}|~{3,})[ \t]*$/);
  return !!match && match[1][0] === fence.char && match[1].length >= fence.length;
}

function escapedAt(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Track display delimiters even when a model puts text before them; ignore inline code. */
function mathLine(line, previous, offset = 0) {
  let math = previous;
  let closedStandalone = false;
  for (let i = 0; i < line.length; i++) {
    if (!math && line[i] === '`' && !escapedAt(line, i)) {
      let end = i + 1;
      while (line[end] === '`') end++;
      const run = line.slice(i, end);
      const close = line.indexOf(run, end);
      if (close >= 0) { i = close + run.length - 1; continue; }
    }
    const token = line.slice(i, i + 2);
    if (escapedAt(line, i)) continue;
    if (math) {
      if (token !== math.close) continue;
      closedStandalone = math.standalone && !line.slice(i + 2).trim();
      math = null;
      i++;
    } else if (token === '$$' || token === '\\[') {
      math = { close: token === '$$' ? '$$' : '\\]', standalone: !line.slice(0, i).trim(), start: offset + i };
      closedStandalone = false;
      i++;
    }
  }
  return { math, closedStandalone };
}

/**
 * Return the end offset of a prefix whose block structure is finished.
 * `from` must be 0 or a previously returned boundary in the same append-only text.
 * Only newline-terminated lines are inspected. Open containers (including loose/nested
 * lists and quotes) stay in the live tail until a following block proves they ended.
 * This deliberately freezes less than a complete Markdown parser, never partial blocks.
 */
export function completedMarkdownEnd(value, from = 0) {
  const text = String(value ?? '');
  const start = Number.isInteger(from) && from >= 0 && from <= text.length
    && (from === 0 || text[from - 1] === '\n') ? from : 0;
  let safe = start;
  let fence = null;
  let math = null;
  let container = null;
  for (let cursor = start; cursor < text.length;) {
    const newline = text.indexOf('\n', cursor);
    if (newline < 0) break;
    const lineStart = cursor;
    const end = newline + 1;
    const line = text.slice(cursor, newline).replace(/\r$/, '');
    cursor = end;
    const content = containerContent(line);
    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
        if (!container) safe = end;
      }
      continue;
    }
    if (math) {
      const next = mathLine(content, math);
      math = next.math;
      if (next.closedStandalone && !container) safe = end;
      continue;
    }
    const blank = !line.trim();
    const indent = indentOf(line);
    const list = line.match(LIST);
    const quote = /^ {0,3}>/.test(line);
    if (container && !blank) {
      const ends = container.kind === 'code' ? indent < 4
        : container.kind === 'list'
          ? indent <= container.indent && !list && (container.blank || ATX.test(line))
          : !quote && (container.blank || ATX.test(line));
      if (ends) { safe = lineStart; container = null; }
    }
    if (blank) {
      if (container) container.blank = true;
      else safe = end;
      continue;
    }
    if (!container) {
      if (list) container = { kind: 'list', indent, blank: false };
      else if (quote) container = { kind: 'quote', indent, blank: false };
      else if (indent >= 4) container = { kind: 'code', indent, blank: false };
    }
    if (container?.kind === 'code') continue;
    if (container) container.blank = !content.trim();
    fence = openingFence(content, line);
    if (fence) continue;
    const next = mathLine(content, null);
    math = next.math;
    if (next.closedStandalone && !container) safe = end;
  }
  return safe;
}

/**
 * Split only the existing numbered-question heading contract (##–#### 第N题 /（N）).
 * Keep each heading in its section so callers can use the normal Markdown renderer.
 * Fenced code, indented code and display formulas cannot create question sections.
 */
export function splitAnswerSections(value) {
  const text = String(value ?? '');
  let fence = null;
  let math = null;
  const matches = [];
  for (let cursor = 0; cursor < text.length;) {
    const newline = text.indexOf('\n', cursor);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(cursor, end).replace(/\r$/, '');
    const start = cursor;
    cursor = newline < 0 ? text.length : newline + 1;
    const content = containerContent(line);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (math) { math = mathLine(content, math).math; continue; }
    if (indentOf(line) >= 4) continue;
    fence = openingFence(content, line);
    if (fence) continue;
    const heading = line.match(QUESTION);
    if (heading) matches.push({ index: start, number: Number(heading[1] || heading[2] || heading[3]) });
    math = mathLine(content, null).math;
  }
  if (matches.length < 2 || matches.some((match, index) => match.number !== index + 1)) return null;
  return {
    intro: text.slice(0, matches[0].index),
    sections: matches.map((match, index) => text.slice(match.index, matches[index + 1]?.index ?? text.length)),
  };
}

/** Return the unmatched $$ / \\[ opener's exact source offset, or -1 when none is open.
 * The final partial line is inspected so a live renderer can hide incomplete LaTeX.
 */
export function unfinishedDisplayMathStart(value) {
  const text = String(value ?? '');
  let fence = null;
  let math = null;
  for (let cursor = 0; cursor < text.length;) {
    const newline = text.indexOf('\n', cursor);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(cursor, end).replace(/\r$/, '');
    const start = cursor;
    cursor = newline < 0 ? text.length : newline + 1;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (math) { math = mathLine(line, math, start).math; continue; }
    if (indentOf(line) >= 4) continue;
    fence = openingFence(containerContent(line), line);
    if (!fence) math = mathLine(line, null, start).math;
  }
  return math?.start ?? -1;
}
