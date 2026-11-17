/** Local bookshelf labels only: file paths and document identities never change. */
export function numericPaperName(name) {
  const stem = String(name || '').replace(/\.pdf$/i, '').replace(/\s*\(\d+\)$/, '');
  return /^(?:arxiv[ _:-]*)?\d{4}\.\d{4,5}(?:v\d+)?$/i.test(stem)
    || /^\d+(?:[._-]\d+)*(?:v\d+)?$/i.test(stem);
}

export function cleanPaperTitle(value, name = '') {
  if (typeof value !== 'string') return '';
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (title.length < 5 || title.length > 320 || !/\p{L}/u.test(title)) return '';
  if (title.toLocaleLowerCase() === String(name).replace(/\.pdf$/i, '').toLocaleLowerCase()) return '';
  if (numericPaperName(title) || /\.(?:pdf|docx?|tex|dvi|ps)$/i.test(title)) return '';
  if (/^(?:untitled|unknown|document\d*|title|paper|manuscript|full\s*text|submission|未命名|无标题)$/i.test(title)) return '';
  if (/^(?:microsoft\s+(?:word|powerpoint)|latex|acrobat|adobe|arxiv\s*:|https?:|doi\s*:)/i.test(title)) return '';
  return title;
}

/** Group horizontal PDF text by baseline, then choose a prominent title block. */
export function firstPageTitle(items, pageHeight, name = '') {
  const runs = (items || []).filter(it => typeof it.str === 'string' && it.str.trim() && it.transform?.length === 6)
    .map(it => ({ text: it.str, x: it.transform[4], y: it.transform[5],
      size: Math.hypot(it.transform[2], it.transform[3]), width: Number(it.width) || 0,
      horizontal: Math.abs(it.transform[1]) < Math.abs(it.transform[0]) * .3 }))
    .filter(it => it.horizontal && it.size > 0 && Number.isFinite(it.y));
  if (!runs.length || !(pageHeight > 0)) return '';
  const sizes = new Map();
  for (const r of runs) sizes.set(Math.round(r.size), (sizes.get(Math.round(r.size)) || 0) + r.text.length);
  const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0][0];
  const lines = [];
  for (const r of runs.filter(r => r.y > pageHeight * .45 && r.y < pageHeight * .97).sort((a, b) => b.y - a.y || a.x - b.x)) {
    let line = lines.find(l => Math.abs(l.y - r.y) < Math.min(l.size, r.size) * .32);
    if (!line) { line = { y: r.y, size: r.size, runs: [] }; lines.push(line); }
    line.size = Math.max(line.size, r.size); line.runs.push(r);
  }
  const noise = /^(?:arxiv\b|https?:|doi\b|proceedings\b|published\b|accepted\b|preprint\b|submitted\b|copyright\b|©|\d{4}\s+(?:ieee|acm)|international\s+conference|journal\s+of|under\s+review)/i;
  for (const l of lines) {
    l.runs.sort((a, b) => a.x - b.x);
    l.text = l.runs.map((r, i) => {
      const prev = l.runs[i - 1];
      return (prev && r.x - prev.x - prev.width > l.size * .08 ? ' ' : '') + r.text;
    }).join('').replace(/\s+/g, ' ').trim();
  }
  const eligible = lines.filter(l => !noise.test(l.text) && cleanPaperTitle(l.text, name));
  const largest = Math.max(0, ...eligible.map(l => l.size));
  // Ambiguous body-sized text is not a title. Scanned/titleless files keep their filename.
  if (largest < bodySize * 1.12 && runs.length > 12) return '';
  const start = lines.findIndex(l => l.size >= largest * .96 && eligible.includes(l));
  if (start < 0) return '';
  const chosen = [lines[start]];
  for (let i = start + 1; i < lines.length && chosen.length < 5; i++) {
    const l = lines[i], prev = chosen[chosen.length - 1];
    if (l.size < largest * .86 || l.size > largest * 1.08 || prev.y - l.y > largest * 1.9
      || noise.test(l.text) || /^(?:abstract|摘要|keywords|introduction)\b/i.test(l.text)) break;
    chosen.push(l);
  }
  return cleanPaperTitle(chosen.map(l => l.text).join(' '), name);
}

export const paperTitleKey = p => JSON.stringify([p.path || p.url || p.name, p.size || 0, p.mtime || 0]);

/** Two background reads at a time; successful misses are cached as well as titles. */
export function createPaperTitleIndex({ storage, readTitle, onChange = () => {} }) {
  const key = 'reader.paperTitles.v1';
  const cache = new Map(), attempted = new Set();
  let pending = [], active = 0;
  try {
    const rows = JSON.parse(storage.getItem(key) || '[]');
    if (Array.isArray(rows)) for (const row of rows.slice(-1000)) {
      if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string') cache.set(row[0], cleanPaperTitle(row[1]));
    }
  } catch { /* Storage can be disabled. */ }
  const save = () => {
    while (cache.size > 1000) cache.delete(cache.keys().next().value);
    try { storage.setItem(key, JSON.stringify([...cache])); } catch { /* Keep the in-memory cache. */ }
  };
  const pump = () => {
    while (active < 2 && pending.length) {
      const p = pending.shift(), id = paperTitleKey(p);
      if (cache.has(id) || attempted.has(id)) continue;
      attempted.add(id); active++;
      Promise.resolve().then(() => readTitle(p.url, p.name)).then(title => {
        cache.set(id, cleanPaperTitle(title, p.name)); save(); onChange();
      }).catch(() => { /* Retry failed files on the next app load; no broken-file toast. */ })
        .finally(() => { active--; pump(); });
    }
  };
  return {
    update(papers) { pending = papers.filter(p => numericPaperName(p.name)); pump(); },
    label(p) {
      const stem = String(p.name || '').replace(/\.pdf$/i, '');
      const title = numericPaperName(p.name) && cache.get(paperTitleKey(p));
      return title ? `${stem} · ${title}` : stem;
    },
  };
}
