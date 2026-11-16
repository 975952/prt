/** Geometric reading order for PDF selection. Never classifies or removes text by content. */

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : 1;
};
const right = (run) => run.left + run.width;
const bottom = (run) => run.top + run.height;
const rtl = (runs) => runs.reduce((sum, run) => sum + (run.direction === 'rtl' ? 1 : -1) * Math.max(1, run.text.trim().length), 0) > 0;

function linesOf(runs) {
  const rows = [];
  for (const run of [...runs].sort((a, b) => a.top - b.top || a.left - b.left || a.sourceIndex - b.sourceIndex)) {
    let closest = null;
    let score = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.bottom < run.top - run.height) break;
      // Compare with one actual line, never its expanding union. A superscript or
      // a neighbouring column can otherwise bridge several separate baselines.
      const reference = row.reference;
      const overlap = Math.min(bottom(reference), bottom(run)) - Math.max(reference.top, run.top);
      const centerGap = Math.abs(reference.top + reference.height / 2 - run.top - run.height / 2);
      const value = overlap / Math.min(reference.height, run.height);
      if (centerGap > Math.max(reference.height, run.height) * 0.6) continue;
      if (value > 0.45 && value > score) { closest = row; score = value; }
    }
    if (!closest) rows.push({ top: run.top, bottom: bottom(run), height: run.height, reference: run, items: [run] });
    else {
      closest.items.push(run);
      closest.top = Math.min(closest.top, run.top);
      closest.bottom = Math.max(closest.bottom, bottom(run));
      closest.height = Math.min(closest.height, run.height);
    }
  }
  return rows.sort((a, b) => a.top - b.top);
}

function columnGutter(rows, bounds) {
  const height = median(rows.flatMap((row) => row.items.map((run) => run.height)));
  const minimum = Math.max(height * 1.8, (bounds.right - bounds.left) * 0.025);
  const paragraphWidth = Math.max(height * 6, (bounds.right - bounds.left) * 0.22);
  const gaps = [];
  const paragraphSegments = [];
  rows.forEach((row, rowIndex) => {
    const items = [...row.items].filter((run) => run.text.trim()).sort((a, b) => a.left - b.left);
    const segments = [];
    for (const item of items) {
      const previous = segments.at(-1);
      if (previous && item.left - previous.right < minimum) previous.right = Math.max(previous.right, right(item));
      else segments.push({ left: item.left, right: right(item) });
    }
    paragraphSegments.push(...segments.filter(segment => segment.right - segment.left >= paragraphWidth)
      .map(segment => ({ ...segment, rowIndex, top: row.top })));
    for (let index = 1; index < segments.length; index += 1) {
      const left = segments[index - 1], next = segments[index];
      // Narrow equation labels/table cells are not evidence of paragraph columns.
      if (left.right - left.left < paragraphWidth || next.right - next.left < paragraphWidth) continue;
      gaps.push({ left: left.right, right: next.left, rowIndex });
    }
  });
  // Independent columns rarely have exactly aligned baselines. Pair nearby
  // paragraph lines as gutter evidence as well; requiring paragraph widths and
  // repeated support below keeps table cells and equation labels out.
  for (const left of paragraphSegments) {
    for (const next of paragraphSegments) {
      if (left.rowIndex === next.rowIndex || Math.abs(left.top - next.top) > height * 1.6) continue;
      if (next.left - left.right < minimum) continue;
      gaps.push({ left: left.right, right: next.left, rowIndex: left.rowIndex });
    }
  }
  let best = null;
  for (const gap of gaps) {
    const x = (gap.left + gap.right) / 2;
    const fraction = (x - bounds.left) / Math.max(1, bounds.right - bounds.left);
    if (fraction < 0.18 || fraction > 0.82) continue;
    const support = gaps.filter((candidate) => candidate.left <= x && candidate.right >= x);
    const rowIds = [...new Set(support.map((candidate) => candidate.rowIndex))];
    if (rowIds.length < Math.max(2, Math.ceil(rows.length * 0.2))) continue;
    const extent = Math.max(...rowIds.map((index) => rows[index].bottom)) - Math.min(...rowIds.map((index) => rows[index].top));
    if (extent < height * 2) continue;
    const sharedWidth = Math.min(...support.map((candidate) => candidate.right)) - Math.max(...support.map((candidate) => candidate.left));
    const score = rowIds.length * Math.max(minimum, sharedWidth);
    if (!best || score > best.score) best = { x, score };
  }
  if (!best) return null;
  // Indented abstracts can suggest a gutter inside the wider body below them.
  // Refine it using full paragraph runs on both sides, excluding shared headings
  // and short author/citation fragments. The flow boundary must lie in real space.
  const paragraphs = rows.flatMap((row) => row.items).filter((run) => run.text.trim()
    && run.width >= paragraphWidth && run.width < (bounds.right - bounds.left) * 0.65);
  const left = paragraphs.filter((run) => run.left + run.width / 2 < best.x);
  const rightRuns = paragraphs.filter((run) => run.left + run.width / 2 >= best.x);
  if (left.length && rightRuns.length) {
    const leftEdge = Math.max(...left.map(right));
    const rightEdge = Math.min(...rightRuns.map((run) => run.left));
    if (leftEdge < rightEdge) return (leftEdge + rightEdge) / 2;
  }
  return best.x;
}

/**
 * Runs carry { text, left, top, width, height, direction? }; other fields are preserved.
 * Coordinates must use one page-local scale. Full-width lines separate column bands.
 * A gutter needs support from multiple rows, so a word gap alone cannot create a column.
 */
export function orderSelectionRuns(input, { width = 0, height = 0 } = {}) {
  const runs = (input || []).map((run, sourceIndex) => ({ ...run, sourceIndex, text: String(run.text ?? '') }))
    .filter((run) => run.text.length && [run.left, run.top, run.width, run.height].every(Number.isFinite)
      && run.width >= 0 && run.height > 0);
  if (!runs.length) return [];
  const pageBounds = { left: 0, right: width || Math.max(...runs.map(right)), top: 0, bottom: height || Math.max(...runs.map(bottom)) };
  const typicalHeight = median(runs.map((run) => run.height));
  const isPeripheral = (run) => Math.abs(Math.sin((Number(run.rotation) || 0) * Math.PI / 180)) > 0.25
    || run.height > Math.max(typicalHeight * 4, pageBounds.bottom * 0.08);
  // Keep rotated margin notes selectable, but give them their own flow after the
  // horizontal text. Their tall boxes must never become a body-line reference.
  const peripheral = runs.filter(isPeripheral);
  const main = runs.filter((run) => !isPeripheral(run));
  const order = (items, bounds, path, depth = 0) => {
    if (!items.length) return [];
    const rows = linesOf(items);
    const gutter = depth < 3 ? columnGutter(rows, bounds) : null;
    if (gutter === null) {
      const flow = { left: bounds.left, right: bounds.right, top: Math.min(...items.map((run) => run.top)), bottom: Math.max(...items.map(bottom)) };
      return rows.flatMap((row, index) => [...row.items].sort((a, b) => rtl(row.items) ? b.left - a.left : a.left - b.left)
        .map((run) => ({ ...run, line: `${path}:${index}`, flow })));
    }
    const output = [];
    let band = [];
    let bandIndex = 0;
    const flush = () => {
      if (!band.length) return;
      const left = band.filter((run) => (run.left + right(run)) / 2 < gutter);
      const rightRuns = band.filter((run) => (run.left + right(run)) / 2 >= gutter);
      const groups = [order(left, { ...bounds, right: gutter }, `${path}.${bandIndex}L`, depth + 1),
        order(rightRuns, { ...bounds, left: gutter }, `${path}.${bandIndex}R`, depth + 1)];
      if (rtl(band)) groups.reverse();
      output.push(...groups.flat());
      band = []; bandIndex += 1;
    };
    rows.forEach((row, index) => {
      // A shared heading must cover substantial text area in both columns. Merely
      // crossing the estimated gutter by a few pixels is still a column-local line.
      // Adjacent fragments can make one heading/author line; a real column gap
      // stays open even when its two baselines happen to overlap vertically.
      const segments = [];
      for (const run of [...row.items].filter((item) => item.text.trim()).sort((a, b) => a.left - b.left)) {
        const previous = segments.at(-1);
        if (previous && run.left - previous.right <= row.reference.height * 0.8) previous.right = Math.max(previous.right, right(run));
        else segments.push({ left: run.left, right: right(run) });
      }
      if (segments.some((segment) => segment.right - segment.left > Math.max(row.reference.height * 4, (bounds.right - bounds.left) * 0.12)
        && segment.left < gutter - row.reference.height * 1.5 && segment.right > gutter + row.reference.height * 1.5)) {
        flush();
        const flow = { left: bounds.left, right: bounds.right, top: row.top, bottom: row.bottom };
        output.push(...[...row.items].sort((a, b) => rtl(row.items) ? b.left - a.left : a.left - b.left)
          .map((run) => ({ ...run, line: `${path}.S${index}`, flow })));
      } else band.push(...row.items);
    });
    flush();
    return output;
  };
  return [...order(main, pageBounds, 'p'), ...peripheral.sort((a, b) => a.top - b.top || a.left - b.left)
    .map((run, index) => ({ ...run, line: `p.margin:${index}`,
      flow: { left: run.left, right: right(run), top: run.top, bottom: bottom(run) } }))];
}

/** Clip to actual character endpoints in geometric order, including backwards selections. */
export function clipSelectionRuns(runs, anchor, focus) {
  if (!anchor || !focus || !runs[anchor.index] || !runs[focus.index]) return [];
  const point = (value) => ({ index: value.index, offset: Math.max(0, Math.min(runs[value.index].text.length, Number(value.offset) || 0)) });
  let first = point(anchor), last = point(focus);
  if (first.index > last.index || (first.index === last.index && first.offset > last.offset)) [first, last] = [last, first];
  return runs.slice(first.index, last.index + 1).map((run, index) => {
    const position = first.index + index;
    const start = position === first.index ? first.offset : 0;
    const end = position === last.index ? last.offset : run.text.length;
    return { ...run, start, end, text: run.text.slice(start, end) };
  }).filter((run) => run.end > run.start);
}

export function selectionTextOf(runs) {
  let text = '';
  let previous = null;
  for (const run of runs) {
    if (previous) {
      if (previous.page !== run.page) text += '\n\n';
      else if (previous.line !== run.line) text += '\n';
      else if (!/\s$/.test(previous.text) && !/^\s/.test(run.text)) {
        const gap = run.direction === 'rtl' ? previous.left - right(run) : run.left - right(previous);
        const cjkPair = /[\u3400-\u9fff\uf900-\ufaff]$/.test(previous.text) && /^[\u3400-\u9fff\uf900-\ufaff]/.test(run.text);
        if (gap > Math.max(0.75, Math.min(previous.height, run.height) * (cjkPair ? 0.65 : 0.15))) text += ' ';
      }
    }
    text += run.text;
    previous = run;
  }
  return text;
}

/** Choose a nearby glyph within the visual column before comparing line distances. */
export function selectionRunAt(runs, x, y) {
  const distance = (point, low, high) => point < low ? low - point : point > high ? point - high : 0;
  let closestFlow = Infinity;
  for (const run of runs) {
    const flow = run.flow || { left: run.left, right: right(run), top: run.top, bottom: bottom(run) };
    const value = distance(x, flow.left, flow.right) ** 2 + distance(y, flow.top, flow.bottom) ** 2;
    closestFlow = Math.min(closestFlow, value);
  }
  let best = null;
  for (const run of runs) {
    const flow = run.flow || { left: run.left, right: right(run), top: run.top, bottom: bottom(run) };
    const flowDistance = distance(x, flow.left, flow.right) ** 2 + distance(y, flow.top, flow.bottom) ** 2;
    if (flowDistance > closestFlow + 0.01) continue;
    const value = distance(y, run.top, bottom(run)) * 10000 + distance(x, run.left, right(run));
    if (!best || value < best.score) best = { run, score: value };
  }
  return best?.run || null;
}
