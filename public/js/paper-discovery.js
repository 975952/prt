/** Read-only local discovery. The caller supplies model-expanded keyword phrases;
 * this module finds and ranks inspectable evidence, without claiming embeddings
 * or using the network. Every PDF is searched before a clean negative result. */
const namedError = (name, message) => Object.assign(new Error(message), { name });
const abortReason = signal => signal?.reason instanceof Error ? signal.reason
  : namedError('AbortError', 'Paper discovery cancelled');
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const meaningfulText = text => (String(text || '').match(/\p{L}/gu) || []).length >= 12;
const numericName = value => /^(?:arxiv[ _:-]*)?\d+(?:[._-]\d+)*(?:v\d+)?$/i.test(String(value || '').replace(/\.pdf$/i, ''));
const titleText = value => String(value || '').replace(/\.pdf$/i, '').trim()
  .replace(/^(?:arxiv[ _:-]*)?\d+(?:[._-]\d+)*(?:v\d+)?\s*[·|]\s*/i, '');

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
  const title = titleText(paper?.displayTitle || paper?.title || name);
  return { path, docId: String(paper?.docId || ''), name,
    title, hasTitle: !numericName(title) && normalize(title) !== normalize(titleText(name)),
    folder: String(paper?.folder || ''), url: String(paper?.url || ''), index };
}

function queryPlan(query, keywords, mode, titles, aliases) {
  const titleList = Array.isArray(titles) ? titles.filter(t => typeof t === 'string') : [];
  const aliasList = Array.isArray(aliases) ? aliases.filter(t => typeof t === 'string') : [];
  const quoted = [...query.matchAll(/[《“"]([^》”"\n]{3,200})[》”"]/g)].map(match => match[1]);
  // Infer names only from the actual request. Broad model-expanded keywords do
  // not turn a topical request into a search for one particular paper.
  const names = (query.match(/[A-Za-z][A-Za-z0-9]*(?:[-–][A-Za-z0-9]+)*/g) || [])
    .filter(word => /[a-z][A-Z]|[A-Z].*\d|^[A-Z]{2,}(?:[-–]|$)/.test(word) && !/^(?:AI|PDF|GPU|CPU|LLM|NLP|CV)$/i.test(word));
  const known = mode === 'known' || (mode !== 'topic' && (titleList.length || aliasList.length || quoted.length || names.length));
  const identity = phrasesFor('', [...titleList, ...aliasList, ...quoted, ...names,
    ...(known && !titleList.length && !aliasList.length && !quoted.length && !names.length ? [query] : [])]);
  const explicitVersion = value => /(?:^|[\s:–_-])(?:v(?:ersion)?\s*)(\d+)\b/i.exec(value)?.[1] || '';
  return { mode: known ? 'known' : 'topic', identity, canonical: phrasesFor('', [...titleList, ...quoted]),
    version: explicitVersion(query) || [...titleList, ...aliasList].map(explicitVersion).find(Boolean) || '',
    phrases: phrasesFor(query, [...keywords, ...titleList, ...aliasList, ...quoted, ...names]) };
}

const filenameVersion = name => /(?:^|[\s._-]|\d)v(?:ersion)?\s*(\d+)(?:\.pdf)?$/i.exec(String(name || ''))?.[1] || '';

function identityMatch(value, plan, revision = '', heading = false) {
  const clean = titleText(value), text = normalize(clean);
  if (!text || numericName(clean) || !plan.identity.length) return null;
  const version = /(?:^|\s)v(?:ersion)?\s*(\d+)\b/i.exec(text)?.[1] || (plan.version ? revision : '');
  if (plan.version ? version !== plan.version : !!version) return null;
  // A target name inside "An Analysis of X" or another title is a mention. An
  // exact title or the leading paper/method name supports identity; a revision
  // suffix denotes a distinct target unless it was explicitly requested.
  const hits = plan.identity.filter(phrase => {
    if (findPhrase(text, phrase.key) !== 0) return false;
    if (text === phrase.key) return true;
    const rest = text.slice(phrase.key.length).trim();
    if (/^(?:for|using|with|on|in|versus|vs|analysis|evaluation|revisited)\b/.test(rest)) return false;
    if (!plan.canonical.length) return /[:：]/.test(clean) || heading;
    // A descriptive title is stronger evidence than an alias prefix. Permit
    // canonical full titles, or an alias whose subtitle matches that title.
    return plan.canonical.some(title => (heading && text.startsWith(title.key))
      || rest === title.key || title.key.endsWith(` ${rest}`));
  });
  if (!hits.length) return null;
  return { hits: hits.map(phrase => ({ phrase: phrase.value })), exact: hits.some(phrase => phrase.key === text) };
}

function metadataMatch(paper, plan) {
  const fields = [...(paper.hasTitle ? [[paper.title, 'title', 115]] : []), [titleText(paper.name), 'filename', 105]];
  for (const [value, matchKind, base] of fields) {
    if (matchKind === 'filename' && paper.hasTitle) continue;
    const own = plan.mode === 'known' && identityMatch(value, plan, filenameVersion(paper.name));
    if (own) return { ...paper, page: null, snippet: String(value), matchKind,
      relation: 'identity', score: base + (own.exact ? 12 : 0), matchedKeywords: own.hits.map(h => h.phrase) };
  }
  for (const [value, matchKind] of fields) {
    const found = matchText(value, plan.phrases);
    if (found) return { ...paper, page: null, snippet: String(value), matchKind,
      relation: plan.mode === 'known' ? 'mention' : 'topic',
      score: 65 + Math.min(15, found.hits.length * 3), matchedKeywords: found.hits.map(h => h.phrase) };
  }
  return null;
}

function firstPageHeading(value) {
  const text = String(value || '').split(/\bAbstract\b|摘要|\bKeywords\b/i)[0].trim();
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const selected = [];
  for (const line of lines) {
    if (/^(?:abstract|摘要|keywords|introduction|references|bibliography|参考文献)\b/i.test(line)) break;
    if (/^(?:arxiv\s*:|https?:|doi\s*:|©|copyright|proceedings\b|published\b|accepted\b|preprint\b|submitted\b|under review)/i.test(line)) continue;
    if (!selected.length && /[.!?。！？]\s*$/.test(line)) break;
    if (selected.length && (/@|university|institute|laboratory|department/i.test(line) || line.length < 4)) break;
    selected.push(line);
    if (selected.length >= 4 || selected.join(' ').length > 350) break;
  }
  return selected.join(' ').split(/\bAbstract\b|摘要|\bKeywords\b/i)[0].trim().slice(0, 420);
}

function confidentTitleBeforeAbstract(value, heading) {
  // Filename aliases are provisional. Only a recognizable title region before
  // an abstract can contradict one; an arbitrary first-page sentence, missing
  // text, or a later body mention is not evidence of a different publication.
  if (!heading || !/\bAbstract\b|摘要/i.test(String(value || ''))) return false;
  if (/^(?:we\b|our\b|this (?:paper|work|study)\b|in this\b|here\b|我们|本文|本研究|该论文)/i.test(heading)) return false;
  const firstLine = heading.split(/\r?\n/)[0];
  if (/@|(?:\b[A-Z][a-z]+\s+[A-Z][a-z]+\s*,){2}/.test(firstLine)) return false;
  return normalize(heading).split(' ').length >= 4 || (heading.match(/[\p{Script=Han}]/gu) || []).length >= 12;
}

function pageRegions(value, referencesStarted) {
  const text = String(value || '');
  if (/^\s*(?:appendix|supplementary|supplemental|附录)\b/i.test(text)) referencesStarted = false;
  const heading = /(?:^|\n)\s*(?:\d+(?:\.\d+)*[.\s]+)?(?:references|bibliography|参考文献|引用文献)\s*(?=\n|\[\d+\]|$)/im.exec(text);
  if (heading) return { body: text.slice(0, heading.index), references: text.slice(heading.index), started: true };
  if (referencesStarted) return { body: '', references: text, started: true };
  // Bibliographic pages may lose their section heading during extraction.
  const citationLines = text.split(/\r?\n/).filter(line => /^\s*\[\d+\]\s*\S/.test(line));
  if (citationLines.length >= 2 && /\b(?:19|20)\d{2}\b/.test(text))
    return { body: text.split(/\r?\n/).filter(line => !citationLines.includes(line)).join('\n'), references: citationLines.join('\n'), started: false };
  return { body: text, references: '', started: false };
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
 * unreadable: PDFs with no usable text or extraction errors. textIncomplete:
 * readable PDFs with some textless pages (blank/image pages, not damaged files).
 * complete remains conservative about missing text, separately from readability.
 * known searches return paper identities; body/bibliography mentions remain auxiliary.
 */
export async function discoverLocalPapers({ query, keywords = [], mode = 'auto', titles = [], aliases = [], papers, paperAccess,
  signal, onProgress, timeBudgetMs = 25000, maxResults = 8 } = {}) {
  if (signal?.aborted) throw abortReason(signal);
  const q = String(query || '').trim().slice(0, 1200);
  const plan = queryPlan(q, Array.isArray(keywords) ? keywords : [], mode, titles, aliases), { phrases } = plan;
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
    complete: false, partial: 0, timedOut: false, readable: 0, textIncomplete: 0, textlessPages: 0, issues: [] };
  const candidates = new Map(), related = new Map(), references = new Map();
  const remember = (candidate, reference = false) => {
    const store = reference ? references : candidate.relation === 'mention' ? related : candidates;
    const previous = store.get(candidate.index);
    if (!previous || candidate.score > previous.score) store.set(candidate.index, candidate);
  };
  // Metadata chooses scan order; it never excludes PDFs from full-text discovery.
  const targets = papers.map((paper, index) => {
    const identity = paperIdentity(paper, index);
    return { ...identity, metadata: metadataMatch(identity, plan) };
  }).sort((a, b) => (b.metadata?.score || 0) - (a.metadata?.score || 0) || a.index - b.index);
  try {
    for (const paper of targets) {
      check();
      if (paper.metadata) remember(paper.metadata);
      let seenPages = 0, textlessPages = 0, referencesStarted = false;
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
            const regions = pageRegions(row.text, referencesStarted);
            referencesStarted = regions.started;
            const heading = row.page === 1 ? firstPageHeading(regions.body) : '';
            const own = heading && plan.mode === 'known' && identityMatch(heading, plan, filenameVersion(paper.name), true);
            if (!own && paper.metadata?.matchKind === 'filename' && paper.metadata.relation === 'identity'
              && plan.canonical.length && confidentTitleBeforeAbstract(regions.body, heading)) {
              candidates.delete(paper.index);
              remember({ ...paper, title: heading, page: 1, snippet: heading,
                matchKind: 'filename-conflict', relation: 'mention', score: 40,
                matchedKeywords: paper.metadata.matchedKeywords });
            }
            if (own) {
              remember({ ...paper, title: numericName(paper.title) ? heading : paper.title,
                page: row.page, snippet: heading, matchKind: paper.metadata?.relation === 'identity' ? 'title+text' : 'first-page-title',
                relation: 'identity', score: (paper.metadata?.relation === 'identity' ? paper.metadata.score : 100) + 15,
                matchedKeywords: own.hits.map(h => h.phrase) });
            }
            for (const [body, reference] of [[regions.body, false], [regions.references, true]]) {
              const found = matchText(body, phrases);
              if (!found) continue;
              const relation = reference || plan.mode === 'known' ? 'mention' : 'topic';
              remember({ ...paper, page: row.page, snippet: evidenceSnippet(body, phrases),
                matchKind: reference ? 'reference' : paper.metadata ? `${paper.metadata.matchKind}+text` : 'text',
                relation, score: reference ? 10 : 55 + Math.min(24, found.hits.length * 6)
                  + (paper.metadata?.relation === 'topic' ? paper.metadata.score * .4 : 0),
                matchedKeywords: found.hits.map(h => h.phrase) }, reference);
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
        if (seenPages > textlessPages) coverage.readable++;
        if (!seenPages || seenPages === textlessPages) {
          coverage.unreadable++; issue('missing_text', { textlessPages, scannedPages: seenPages });
        } else if (textlessPages) {
          coverage.textIncomplete++; issue('partial_text', { textlessPages, scannedPages: seenPages });
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
    && coverage.textIncomplete === 0 && coverage.partial === 0 && !coverage.timedOut;
  const output = store => [...store.values()].sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map(({ metadata, index, url, hasTitle, ...candidate }) => candidate);
  // A paper's own identity must not also appear as its own "related citation".
  for (const index of candidates.keys()) { related.delete(index); references.delete(index); }
  const matches = output(candidates);
  return { query: q, mode: plan.mode, keywords: phrases.map(p => p.value), matches,
    relatedMatches: output(related), referenceMatches: output(references), coverage,
    status: matches.length ? 'matched' : coverage.complete ? 'not_found' : 'incomplete' };
}
