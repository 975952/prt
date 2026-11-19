const MAX_TOC_PAGES = 20;
const MAX_TOC_ENTRIES = 120;
const MAX_TITLE_LENGTH = 180;
const MAX_PRINTED_PAGE = 9999;

const cleanText = (value, max = MAX_TITLE_LENGTH) => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\ufeff]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

export function romanToInt(value) {
  const roman = String(value ?? '').trim().toUpperCase();
  if (!roman || !/^(?=.)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const current = values[roman[i]];
    total += current < (values[roman[i + 1]] || 0) ? -current : current;
  }
  return total;
}

/** Returns a canonical page token, or null when the token is not a positive page label. */
export function normalizePrintedPage(label) {
  if (label && typeof label === 'object') {
    label = label.label ?? label.printedPage ?? label.value;
  }
  let token = cleanText(label, 40).replace(/^[([{]+|[)\]}]+$/g, '').trim();
  token = token.replace(/^(?:page|p)\s*\.?\s*/i, '').replace(/[.。]+$/g, '').trim();
  if (/^\d{1,5}$/.test(token)) {
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PRINTED_PAGE) return null;
    return { scheme: 'arabic', value, label: String(value) };
  }
  const value = romanToInt(token);
  if (value === null || value > MAX_PRINTED_PAGE) return null;
  return { scheme: 'roman', value, label: token.toLowerCase() };
}

function isContentsHeading(line) {
  let value = cleanText(line, 120).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  value = value.replace(/(?:continued|continuation|续|续篇)$/i, '');
  return /^(?:tableofcontents|contents|content|目录|目次|目錄|目录表|目次表|目录页|目次页|toc)$/.test(value);
}

const SECTION_PREFIX = /^(?:第\s*[0-9一二三四五六七八九十百零〇]+\s*[章节节篇部分]|\d+(?:[.．]\d+)*)(?=\s|[、:：.)．]|$)/u;
const ROMAN_SECTION_PREFIX = /^(?:[IVXLCDM]{1,8})(?:[.．、)]|\s+)/i;

function levelFromTitle(title, indent, baseIndent) {
  const numbered = /^(\d+(?:[.．]\d+)*)\s*(?=\S)/u.exec(title);
  if (numbered) return Math.min(6, numbered[1].split(/[.．]/).length);
  if (/^第\s*[0-9一二三四五六七八九十百零〇]+\s*[章节节篇部分]/u.test(title)) return 1;
  if (ROMAN_SECTION_PREFIX.test(title)) return 1;
  return Math.max(1, Math.min(6, Math.floor(Math.max(0, indent - baseIndent) / 2) + 1));
}

function parseTocLine(rawLine, baseIndent = 0) {
  const line = String(rawLine || '').replace(/\u00ad/g, '').normalize('NFKC');
  const indent = (/^[ \t]*/.exec(line)?.[0] || '').replace(/\t/g, '  ').length;
  const body = line.trim();
  const match = /^(.*?)(?:(?:\.{2,}|…+|·{2,}|_{2,}|—{2,}|–{2,})\s*|\s+)([0-9]{1,5}|[ivxlcdm]{1,8})[.)。]?\s*$/i.exec(body);
  if (!match) return null;
  const title = match[1].replace(/[.·…_—–\s]+$/u, '').replace(/^[.·…_—–\s]+/u, '').trim();
  const printed = normalizePrintedPage(match[2]);
  if (!printed || title.length < 2 || title.length > 400 || /[。！？?!]$/u.test(title)) return null;
  const hasLeader = /(?:\.{2,}|…+|·{2,}|_{2,}|—{2,}|–{2,})/u.test(body);
  if (!hasLeader && !SECTION_PREFIX.test(title) && !ROMAN_SECTION_PREFIX.test(title) && title.length > 100) return null;
  return {
    title: cleanText(title),
    level: levelFromTitle(title, indent, baseIndent),
    printedPage: printed.label,
    printedScheme: printed.scheme,
    printedValue: printed.value,
    confidence: hasLeader ? 0.88 : 0.74,
  };
}

function pageNumber(row, fallback) {
  const n = Number(row?.page);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Parse text-extracted pages in PDF order. Input rows are { page, text }, with errors preserved. */
export function parseTextContentsPages(pages) {
  const rows = Array.isArray(pages) ? pages.slice(0, MAX_TOC_PAGES) : [];
  const ordered = rows.map((row, index) => ({ row, page: pageNumber(row, index + 1), index }))
    .sort((a, b) => a.page - b.page || a.index - b.index);
  const headingPages = [];
  const unreadablePages = [];
  const entries = [];
  const seen = new Set();
  let inContents = false;
  let emptyContinuationPages = 0;
  let stoppedAtPage = null;

  for (const { row, page } of ordered) {
    if (!row || row.readable === false || row.error || typeof row.text !== 'string') {
      unreadablePages.push(page);
      if (inContents) emptyContinuationPages++;
      if (emptyContinuationPages >= 2) { stoppedAtPage = page; break; }
      continue;
    }
    const lines = row.text.replace(/\r\n?/g, '\n').split('\n');
    const foundHeading = lines.some(isContentsHeading);
    if (foundHeading) {
      inContents = true;
      headingPages.push(page);
    }
    if (!inContents) continue;

    const indentBase = Math.min(...lines.filter((line) => line.trim()).map((line) => (/^[ \t]*/.exec(line)?.[0] || '').replace(/\t/g, '  ').length), 0);
    let added = 0;
    for (let i = 0; i < lines.length && entries.length < MAX_TOC_ENTRIES; i++) {
      if (isContentsHeading(lines[i])) continue;
      let parsed = parseTocLine(lines[i], indentBase);
      if (!parsed && i + 1 < lines.length && /^\s*(?:[0-9]{1,5}|[ivxlcdm]{1,8})[.)。]?\s*$/i.test(lines[i + 1])) {
        parsed = parseTocLine(`${lines[i].trim()} ${lines[i + 1].trim()}`, indentBase);
        if (parsed) i++;
      }
      if (!parsed) continue;
      const key = `${parsed.title.toLocaleLowerCase()}\u0000${parsed.printedPage}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...parsed, tocPage: page });
      added++;
    }
    if (foundHeading || added > 0) emptyContinuationPages = 0;
    else emptyContinuationPages++;
    if (emptyContinuationPages >= 2) { stoppedAtPage = page; break; }
  }

  return {
    found: headingPages.length > 0,
    headingPages,
    entries,
    unreadablePages: [...new Set(unreadablePages)],
    pagesRead: ordered.length,
    stoppedAtPage,
  };
}

function parseModelJson(value) {
  if (typeof value !== 'string') return value;
  const source = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').slice(0, 100_000);
  try { return JSON.parse(source); } catch { return null; }
}

/** Strictly validate and bound structured vision-model output; never trust model-supplied markup or page IDs. */
export function normalizeVisionTocResult(value, pages = []) {
  const parsed = parseModelJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.entries)) {
    return { ok: false, reason: typeof value === 'string' ? 'invalid-json' : 'invalid-shape', detected: false, entries: [], issues: ['invalid-response'] };
  }
  const providedPages = new Set((Array.isArray(pages) ? pages : []).map((item) =>
    Number(typeof item === 'object' && item !== null ? item.page : item))
    .filter((page) => Number.isInteger(page) && page > 0));
  const issues = [];
  const entries = [];
  let rejected = 0;
  for (const raw of parsed.entries.slice(0, MAX_TOC_ENTRIES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { rejected++; continue; }
    const title = cleanText(raw.title);
    const printed = normalizePrintedPage(raw.printedPage ?? raw.printedLabel ?? raw.pageLabel);
    const level = Number(raw.level);
    const confidence = raw.confidence == null ? null : Number(raw.confidence);
    const sourcePage = raw.sourcePage == null ? null : Number(raw.sourcePage);
    if (!title || !printed || !Number.isInteger(level) || level < 1 || level > 6
      || (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))
      || (sourcePage !== null && (!Number.isInteger(sourcePage) || !providedPages.has(sourcePage)))) {
      rejected++;
      continue;
    }
    entries.push({ title, printedPage: printed.label, printedScheme: printed.scheme, printedValue: printed.value,
      level, confidence, sourcePage });
  }
  if (parsed.entries.length > MAX_TOC_ENTRIES) issues.push('entries-truncated');
  if (rejected) issues.push('entries-rejected');
  if (typeof parsed.detected !== 'boolean' && parsed.detected !== undefined) issues.push('invalid-detected-flag');
  const detected = parsed.detected === true || (parsed.detected === undefined && entries.length > 0);
  return {
    ok: true,
    detected: detected && entries.length > 0,
    entries,
    confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence)) : null,
    issues,
    rejectedEntries: rejected,
  };
}

function labelRecord(value, index) {
  const page = Number(value && typeof value === 'object' ? value.page : index + 1);
  const label = value && typeof value === 'object' ? value.label : value;
  const parsed = normalizePrintedPage(label);
  return Number.isInteger(page) && page > 0 && parsed ? { page, ...parsed } : null;
}

function sequenceOffset(records) {
  if (records.length < 2) return { offset: null, valid: false, reason: 'insufficient-labels' };
  const offsets = new Set();
  for (let i = 0; i < records.length; i++) {
    offsets.add(records[i].page - records[i].value);
    if (i && (records[i].page <= records[i - 1].page || records[i].value <= records[i - 1].value)) {
      return { offset: null, valid: false, reason: 'non-monotonic-labels' };
    }
  }
  if (offsets.size !== 1) return { offset: null, valid: false, reason: 'ambiguous-offset' };
  return { offset: [...offsets][0], valid: true, reason: '' };
}

/** Map printed labels only from unique observed labels or a stable, monotonic per-scheme offset. */
export function mapPrintedPages(entries, pageLabels, numPages) {
  const input = Array.isArray(entries) ? entries : [];
  const labels = Array.isArray(pageLabels) ? pageLabels : [];
  const total = Number.isInteger(Number(numPages)) && Number(numPages) > 0 ? Number(numPages) : labels.length;
  const records = labels.slice(0, total).map(labelRecord).filter(Boolean);
  const byScheme = {
    arabic: records.filter((row) => row.scheme === 'arabic'),
    roman: records.filter((row) => row.scheme === 'roman'),
  };
  const sequence = {
    arabic: sequenceOffset(byScheme.arabic),
    roman: sequenceOffset(byScheme.roman),
  };
  const mapped = input.map((entry, index) => {
    const printed = normalizePrintedPage(entry?.printedPage ?? entry?.printedLabel ?? entry?.pageLabel);
    if (!printed) return { ...entry, actualPage: null, mappingStatus: 'unresolved', mappingReason: 'invalid-printed-page' };
    const exact = records.filter((row) => row.scheme === printed.scheme && row.value === printed.value);
    if (exact.length === 1 && exact[0].page <= total) {
      return { ...entry, actualPage: exact[0].page, mappingStatus: 'mapped', mappingSource: 'observed-label', mappingReason: '' };
    }
    if (exact.length > 1) {
      return { ...entry, actualPage: null, mappingStatus: 'unresolved', mappingReason: 'duplicate-label' };
    }
    const estimate = sequence[printed.scheme];
    if (!estimate.valid) {
      return { ...entry, actualPage: null, mappingStatus: 'unresolved', mappingReason: estimate.reason || 'label-not-observed' };
    }
    const actualPage = printed.value + estimate.offset;
    if (!Number.isInteger(actualPage) || actualPage < 1 || actualPage > total) {
      return { ...entry, actualPage: null, mappingStatus: 'unresolved', mappingReason: 'out-of-bounds' };
    }
    const actualLabel = labelRecord(labels[actualPage - 1], actualPage - 1);
    if (!actualLabel) {
      // A sparse array means this page was not sampled; an explicit null means
      // it was observed as unreadable or unlabeled and must stay unresolved.
      if (!Object.hasOwn(labels, actualPage - 1)) {
        return { ...entry, actualPage, mappingStatus: 'mapped', mappingSource: 'sequence-offset', mappingReason: '' };
      }
      return { ...entry, actualPage: null, mappingStatus: 'unresolved', mappingReason: 'label-missing-at-target' };
    }
    if (actualLabel.scheme !== printed.scheme || actualLabel.value !== printed.value) {
      return { ...entry, actualPage: null, mappingStatus: 'unresolved', mappingReason: 'label-conflict' };
    }
    return { ...entry, actualPage, mappingStatus: 'mapped', mappingSource: 'sequence-offset', mappingReason: '' };
  });
  const mappedCount = mapped.filter((entry) => entry.mappingStatus === 'mapped').length;
  const offsets = {
    arabic: sequence.arabic.valid ? sequence.arabic.offset : null,
    roman: sequence.roman.valid ? sequence.roman.offset : null,
  };
  return {
    entries: mapped,
    offsets,
    sequenceStatus: { arabic: sequence.arabic.reason, roman: sequence.roman.reason },
    mappedCount,
    unresolvedCount: mapped.length - mappedCount,
    complete: mapped.length > 0 && mappedCount === mapped.length,
  };
}

/** Confidence gate for UI/cache success. Missing mapping data is neutral; supplied mapping must be adequate. */
export function assessTocConfidence(result = {}) {
  const source = Array.isArray(result) ? { entries: result } : (result && typeof result === 'object' ? result : {});
  const entries = Array.isArray(source.entries) ? source.entries : [];
  const headingFound = source.headingFound === true || source.found === true
    || source.detected === true || (Array.isArray(source.headingPages) && source.headingPages.length > 0);
  const validPages = entries.filter((entry) => normalizePrintedPage(entry?.printedPage ?? entry?.printedLabel ?? entry?.pageLabel)).length;
  const mappedRows = Array.isArray(source.mapping?.entries) ? source.mapping.entries : entries;
  const hasMapping = mappedRows.some((entry) => entry?.mappingStatus || entry?.actualPage != null);
  const mappedCount = mappedRows.filter((entry) => Number.isInteger(Number(entry?.actualPage)) && Number(entry.actualPage) > 0).length;
  const mapRatio = mappedRows.length ? mappedCount / mappedRows.length : 0;
  const entryConfidence = entries.map((entry) => Number(entry?.confidence))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  const modelConfidence = Number(source.confidence);
  const confidenceSignals = [...entryConfidence, ...(Number.isFinite(modelConfidence) && modelConfidence >= 0 && modelConfidence <= 1 ? [modelConfidence] : [])];
  const signalQuality = confidenceSignals.length
    ? confidenceSignals.reduce((sum, value) => sum + value, 0) / confidenceSignals.length
    : 0.78;
  const pageRatio = entries.length ? validPages / entries.length : 0;
  const mapQuality = hasMapping ? mapRatio : 0.72;
  const unreadableCount = Array.isArray(source.unreadablePages) ? source.unreadablePages.length : 0;
  const score = Math.max(0, Math.min(1,
    (headingFound ? 0.22 : 0)
    + 0.26 * Math.min(1, entries.length / 5)
    + 0.18 * pageRatio
    + 0.22 * mapQuality
    + 0.12 * signalQuality
    - Math.min(0.18, unreadableCount * 0.04)));
  const reasons = [];
  if (!headingFound) reasons.push('contents-heading-not-found');
  if (entries.length < 3) reasons.push('too-few-entries');
  if (pageRatio < 0.75) reasons.push('invalid-page-labels');
  if (hasMapping && mapRatio < 0.5) reasons.push('too-many-unmapped-pages');
  if (signalQuality < 0.55) reasons.push('low-recognition-confidence');
  if (unreadableCount) reasons.push('unreadable-pages');
  const confident = headingFound && entries.length >= 3 && pageRatio >= 0.75
    && (!hasMapping || mapRatio >= 0.5) && signalQuality >= 0.55 && score >= 0.68;
  return {
    score: Number(score.toFixed(3)),
    confident,
    reasons,
    entryCount: entries.length,
    mappedCount: hasMapping ? mappedCount : null,
    unresolvedCount: hasMapping ? Math.max(0, mappedRows.length - mappedCount) : null,
  };
}
