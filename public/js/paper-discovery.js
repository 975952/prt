/** Read-only local discovery. The caller supplies model-expanded keyword phrases;
 * this module finds and ranks inspectable evidence, without claiming embeddings
 * or using the network. Every PDF is searched before a clean negative result. */
const namedError = (name, message) => Object.assign(new Error(message), { name });
const abortReason = signal => signal?.reason instanceof Error ? signal.reason
  : namedError('AbortError', 'Paper discovery cancelled');
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const meaningfulText = text => (String(text || '').match(/\p{L}/gu) || []).length >= 12;

function phrasesFor(query, keywords) {
  const seen = new Set();
  return [query, ...(Array.isArray(keywords) ? keywords : [])].slice(0, 25)
    .filter(value => typeof value === 'string').map(value => value.trim().slice(0, 300))
    .filter(value => {
      const key = normalize(value);
      if (key.length < 2 || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(value => ({ value, key: normalize(value) }));
}

function findPhrase(text, phrase) {
  let at = text.indexOf(phrase);
  // Latin abbreviations such as AI must not match the middle of an English word.
  while (at >= 0) {
    const before = text[at - 1] || '', after = text[at + phrase.length] || '';
    if ((!/^[a-z0-9]/i.test(phrase) || !/[a-z0-9]/i.test(before))
      && (!/[a-z0-9]$/i.test(phrase) || !/[a-z0-9]/i.test(after))) return at;
    at = text.indexOf(phrase, at + 1);
  }
  return -1;
}

function matchText(value, phrases) {
  const text = normalize(value), hits = [];
  for (const phrase of phrases) {
    const at = findPhrase(text, phrase.key);
    if (at >= 0) hits.push({ phrase: phrase.value, at, length: phrase.key.length });
  }
  if (!hits.length) return null;
  const first = hits.reduce((a, b) => a.at < b.at ? a : b);
  return { hits, at: first.at, length: first.length };
}

function evidenceSnippet(value, phrases) {
  // Match a whitespace-normalized original to retain readable spelling. When PDF
  // punctuation/NFKC normalization changes offsets, locate the phrase by tokens.
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  let at = -1;
  for (const phrase of phrases) {
    const tokens = phrase.key.split(' ').map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const found = new RegExp(tokens.join('[^\\p{L}\\p{N}]+'), 'iu').exec(text);
    if (found && (at < 0 || found.index < at)) at = found.index;
  }
  if (at < 0) return normalize(text).slice(Math.max(0, (matchText(text, phrases)?.at || 0) - 100),
    Math.max(0, (matchText(text, phrases)?.at || 0) - 100) + 420);
  const start = Math.max(0, at - 100);
  return `${start ? '…' : ''}${text.slice(start, start + 420)}${text.length > start + 420 ? '…' : ''}`;
}

function paperIdentity(paper, index) {
  const path = String(paper?.path || ''), name = String(paper?.name || path.split(/[\\/]/).pop() || '');
  return { path, docId: String(paper?.docId || ''), name,
    title: String(paper?.displayTitle || paper?.title || name.replace(/\.pdf$/i, '')),
    folder: String(paper?.folder || ''), url: String(paper?.url || ''), index };
}

function metadataMatch(paper, phrases) {
  const fields = [[paper.title, 'title', 70], [paper.name, 'filename', 50], [paper.path, 'path', 20]];
  for (const [value, matchKind, base] of fields) {
    const found = matchText(value, phrases);
    if (found) return { ...paper, page: null, snippet: String(value), matchKind,
      score: base + Math.min(15, found.hits.length * 3), matchedKeywords: found.hits.map(h => h.phrase) };
  }
  return null;
}

function consume(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(abortReason(signal)); };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', cancel); resolve(value);
    }, error => { signal.removeEventListener('abort', cancel); reject(error); });
    if (signal.aborted) cancel();
  });
}

/**
 * checked: PDFs whose entire page range was inspected (including textless PDFs).
 * unreadable: PDFs with missing text or extraction errors. remaining=total-checked.
 * complete requires all pages inspected AND usable text; even a single textless
 * page prevents claiming absence. Matches are candidates, not semantic verdicts.
 */
export async function discoverLocalPapers({ query, keywords = [], papers, paperAccess,
  signal, onProgress, timeBudgetMs = 25000, maxResults = 8 } = {}) {
  if (signal?.aborted) throw abortReason(signal);
  const q = String(query || '').trim().slice(0, 1200), phrases = phrasesFor(q, keywords);
  if (!q || !phrases.length) throw new TypeError('A meaningful discovery query is required');
  if (!Array.isArray(papers)) throw new TypeError('papers must be the complete requested library scope');
  if (typeof paperAccess?.search !== 'function') throw new TypeError('paperAccess.search is required');
  const budget = Math.max(0, Number.isFinite(Number(timeBudgetMs)) ? Number(timeBudgetMs) : 25000);
  const limit = Math.max(1, Math.min(40, Math.floor(Number(maxResults) || 8)));
  const controller = new AbortController(), deadline = Date.now() + budget;
  const timeout = () => controller.abort(namedError('TimeoutError', 'Local discovery time budget exhausted'));
  const forwardAbort = () => controller.abort(abortReason(signal));
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(timeout, budget);
  let stopped = false;
  const check = () => {
    if (signal?.aborted) throw abortReason(signal);
    if (!controller.signal.aborted && Date.now() >= deadline) timeout();
    if (controller.signal.aborted) throw abortReason(controller.signal);
    if (stopped) throw namedError('AbortError', 'Paper discovery finished');
  };
  const coverage = { total: papers.length, checked: 0, unreadable: 0, remaining: papers.length,
    complete: false, partial: 0, timedOut: false, textlessPages: 0, issues: [] };
  const candidates = new Map();
  // Metadata chooses scan order; it never excludes PDFs from full-text discovery.
  const targets = papers.map((paper, index) => {
    const identity = paperIdentity(paper, index);
    return { ...identity, metadata: metadataMatch(identity, phrases) };
  }).sort((a, b) => (b.metadata?.score || 0) - (a.metadata?.score || 0) || a.index - b.index);
  try {
    for (const paper of targets) {
      check();
      if (paper.metadata) candidates.set(paper.index, paper.metadata);
      let seenPages = 0, textlessPages = 0, best = null;
      const issue = (reason, extra = {}) => coverage.issues.push({ path: paper.path, docId: paper.docId,
        name: paper.name, reason, ...extra });
      onProgress?.({ phase: 'paper', paper: paper.name, path: paper.path,
        checked: coverage.checked, total: coverage.total, remaining: coverage.remaining });
      try {
        if (!paper.url) throw new Error('PDF URL is missing');
        const result = await consume(paperAccess.search(paper.url, q, {
          signal: controller.signal, timeBudgetMs: Math.max(1, deadline - Date.now()),
          // Keep only our best candidate while letting paperAccess visit every page.
          maxHits: 1,
          matchPage(row) {
            check(); seenPages++;
            if (!meaningfulText(row.text)) textlessPages++;
            const found = matchText(row.text, phrases);
            if (found) {
              const score = 55 + Math.min(24, found.hits.length * 6) + (paper.metadata?.score || 0) * .4;
              if (!best || score > best.score) {
                best = { ...paper, page: row.page, snippet: evidenceSnippet(row.text, phrases),
                  matchKind: paper.metadata ? `${paper.metadata.matchKind}+text` : 'text', score,
                  matchedKeywords: found.hits.map(h => h.phrase) };
                candidates.set(paper.index, best);
              }
            }
            return [];
          },
          onProgress(progress) {
            check(); onProgress?.({ phase: 'page', paper: paper.name, path: paper.path,
              page: progress.page, numPages: progress.numPages,
              checked: coverage.checked, total: coverage.total });
          },
        }), controller.signal);
        check();
        const full = result?.complete === true && !result.truncated && !result.timedOut
          && Number(result.numPages) > 0 && seenPages >= Number(result.numPages)
          && Number(result.scanned) >= Number(result.numPages);
        if (full) coverage.checked++;
        else { coverage.partial++; issue(result?.timedOut ? 'timeout' : 'partial',
          { scannedPages: seenPages, numPages: Number(result?.numPages) || 0 }); }
        if (result?.timedOut) coverage.timedOut = true;
        if (textlessPages || !seenPages) {
          coverage.unreadable++; issue('missing_text', { textlessPages, scannedPages: seenPages });
        }
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        if (error?.name === 'TimeoutError' || controller.signal.aborted) {
          coverage.partial++; coverage.timedOut = true;
          issue('timeout', { scannedPages: seenPages });
        } else {
          coverage.unreadable++; issue('read_error', { scannedPages: seenPages,
            message: String(error?.message || error).slice(0, 200) });
        }
        // A deadline ends the entire operation, even for non-cooperative adapters.
        if (controller.signal.aborted || Date.now() >= deadline) break;
      } finally {
        coverage.textlessPages += textlessPages;
        coverage.remaining = coverage.total - coverage.checked;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (error?.name !== 'TimeoutError') throw error;
    coverage.timedOut = true;
  } finally {
    stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', forwardAbort);
  }
  if (signal?.aborted) throw abortReason(signal);
  coverage.complete = coverage.remaining === 0 && coverage.unreadable === 0
    && coverage.partial === 0 && !coverage.timedOut;
  const matches = [...candidates.values()].sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map(({ metadata, index, url, ...candidate }) => candidate);
  return { query: q, keywords: phrases.map(p => p.value), matches, coverage,
    status: matches.length ? 'matched' : coverage.complete ? 'not_found' : 'incomplete' };
}
