import { runWithDeadline } from './task-deadline.js';

export function paperDiscoveryIntent(value) {
  const text = String(value || '');
  return /(?:找|搜|检索|推荐|下载|想看|想读|寻找|有没有|哪.{0,8}篇|find|search|look\s+for|recommend|download|locate)/i.test(text)
    && /(?:论文|文献|文章|研究|paper|article|research|study|arxiv|\.pdf|《)/i.test(text);
}

export function safePaperLink(value) {
  try {
    const url = new URL(String(value || ''));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

const QUERY_LIMIT = 200;
const clean = (value, limit = QUERY_LIMIT) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
const normalize = value => clean(value, 6000).normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/g, '-');
const uniqueText = (values, limit) => [...new Map((Array.isArray(values) ? values : [])
  .filter(value => typeof value === 'string').map(value => clean(value)).filter(Boolean)
  .map(value => [normalize(value), value])).values()].slice(0, limit);
const REQUEST_WORDS = new Set(('a an the of on in for from to with by and or is are was were this that these those '
  + 'i me my we our you your it its can could please want read find search looking look recommend show about '
  + 'paper papers article articles publication publications study studies research discovery lookup latest related pdf').split(' '));
const TITLE_WORDS = new Set('a an the of on in for from to with by and or'.split(' '));
const BROAD_WORDS = new Set('model system method network transformer attention analysis approach efficient result performance'.split(' '));
const CHINESE_REQUEST = new Set(['我', '想', '看', '看看', '找', '查找', '寻找', '帮', '帮我', '请', '一下', '关于', '相关', '论文', '文章', '文献', '研究', '的', '了', '一篇']);
const stem = word => word.length > 4 && /s$/.test(word) && !/(ss|is|us)$/.test(word) ? word.slice(0, -1) : word;
function tokens(value, title = false) {
  const text = normalize(value), stop = title ? TITLE_WORDS : REQUEST_WORDS;
  const latin = (text.match(/[a-z0-9]+/g) || []).filter(word => word.length > 1 && !stop.has(word)).map(stem);
  const chinese = text.match(/[\p{Script=Han}]+/gu) || [];
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
  for (const chunk of chinese) {
    for (const word of segmenter ? [...segmenter.segment(chunk)].map(row => row.segment) : [chunk]) {
      if (word.length > 1 && (title || !CHINESE_REQUEST.has(word))) latin.push(word);
    }
  }
  return [...new Set(latin)];
}
function combineQuery(parts) {
  let query = '';
  for (const part of parts.map(value => clean(value)).filter(Boolean)) {
    if (normalize(query).includes(normalize(part))) continue;
    const available = QUERY_LIMIT - query.length - (query ? 1 : 0);
    if (available <= 0) break;
    query += (query ? ' ' : '') + part.slice(0, available);
  }
  return query;
}
const hostIs = (host, root) => host === root || host.endsWith(`.${root}`);
function scholarlyLink(value) {
  if (!value) return false;
  const { hostname: host, pathname: route, searchParams } = new URL(value);
  if (hostIs(host, 'doi.org')) return /^\/10\.\d{4,9}\/.+/i.test(route);
  if (hostIs(host, 'arxiv.org')) return /^\/(?:abs|pdf)\/(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?(?:\.pdf)?\/?$/i.test(route);
  if (['biorxiv.org', 'medrxiv.org'].some(root => hostIs(host, root))) return /^\/content\/10\./.test(route);
  if (hostIs(host, 'openreview.net')) return /^\/(?:forum|pdf)\/?$/.test(route) && !!searchParams.get('id');
  if (hostIs(host, 'semanticscholar.org')) return /^\/paper\/.+\/[a-f\d]{20,}$/i.test(route);
  if (hostIs(host, 'pubmed.ncbi.nlm.nih.gov')) return /^\/\d+\/?$/.test(route);
  if (hostIs(host, 'ncbi.nlm.nih.gov')) return /\/(?:pmc\/)?articles\/PMC\d+/i.test(route);
  if (hostIs(host, 'proceedings.mlr.press')) return /^\/v\d+\/.+\.(?:html|pdf)$/.test(route);
  if (hostIs(host, 'openaccess.thecvf.com')) return /^\/content[^/]*\/(?:[^/]+\/)?(?:html|papers)\/.+\.(?:html|pdf)$/.test(route);
  if (['proceedings.neurips.cc', 'papers.nips.cc'].some(root => hostIs(host, root))) return /^\/(?:paper_files\/paper|paper)\/.+/.test(route);
  if (hostIs(host, 'aclanthology.org')) return /^\/(?:[A-Z]\d{2}-\d{4}|\d{4}\.[a-z][a-z\d.-]*\.\d+)(?:\.pdf)?\/?$/i.test(route);
  if (hostIs(host, 'jmlr.org')) return /^\/papers\/(?:v\d+|volume\d+)\/.+/.test(route);
  const publishers = [
    ['nature.com', /^\/articles\/.+/], ['science.org', /^\/doi\/.+/],
    ['sciencedirect.com', /^\/science\/article\/pii\/.+/], ['ieeexplore.ieee.org', /^\/document\/\d+/],
    ['dl.acm.org', /^\/doi\/.+/], ['springer.com', /^\/(?:article|chapter|content\/pdf)\/.+/],
    ['onlinelibrary.wiley.com', /^\/doi\/.+/], ['journals.aps.org', /^\/[^/]+\/(?:abstract|pdf)\/.+/],
    ['iopscience.iop.org', /^\/article\/.+/], ['academic.oup.com', /^\/[^/]+\/article\/.+/],
    ['journals.plos.org', /^\/[^/]+\/article/], ['frontiersin.org', /^\/(?:journals\/[^/]+\/)?articles\/.+/],
    ['mdpi.com', /^\/\d+-\d+\/\d+\/\d+\/\d+/], ['tandfonline.com', /^\/doi\/.+/],
    ['cambridge.org', /^\/core\/journals\/[^/]+\/article\/.+/], ['aaai.org', /\/article\/(?:view|download)\//],
  ];
  if (publishers.some(([root, pattern]) => hostIs(host, root) && pattern.test(route))) return true;
  if (hostIs(host, 'ssrn.com')) return !!searchParams.get('abstract_id') || /^\/abstract=\d+/.test(route);
  if (hostIs(host, 'osf.io')) return /^\/preprints\/(?:[^/]+\/)?[a-z\d]+\/?$/i.test(route);
  if (hostIs(host, 'hal.science') || hostIs(host, 'archives-ouvertes.fr')) return /^\/(?:hal|tel|inria)-\d+/i.test(route);
  // A generic website ending in .pdf is not bibliographic evidence. Direct PDF
  // results need an identifiable institutional or research repository host.
  return /\.pdf$/i.test(route) && (/\.(?:edu|edu\.[a-z]{2}|ac\.[a-z]{2})$/i.test(host)
    || ['github.io', 'raw.githubusercontent.com', 'zenodo.org', 'eprints.org'].some(root => hostIs(host, root)));
}
const ACADEMIC_SOURCES = new Set(['arxiv', 'openalex', 'crossref', 'semanticscholar']);
function sourceLinks(raw, channel) {
  const url = safePaperLink(raw.url), pdfUrl = safePaperLink(raw.pdfUrl);
  const knownRecord = channel === 'academic' && ACADEMIC_SOURCES.has(normalize(raw.source).replace(/\s/g, ''));
  const documentUrl = scholarlyLink(url), documentPdf = scholarlyLink(pdfUrl);
  if (!knownRecord && !documentUrl && !documentPdf) return null;
  // If only the PDF is verifiable, the unrelated landing page does not become
  // a paper source merely because the web result also supplied that PDF.
  const link = knownRecord ? url || pdfUrl : documentUrl ? url : pdfUrl;
  if (!link) return null;
  return { url: link, pdfUrl: pdfUrl && (knownRecord || documentPdf) ? pdfUrl : /\.pdf(?:[?#]|$)/i.test(link) ? link : '' };
}
function titleIdentities(value) {
  const title = clean(value, 600).replace(/^\s*\[(?:pdf|html|preprint)\]\s*/i, '')
    .replace(/\s+[|–—-]\s+(?:arxiv|openreview|semantic scholar|google scholar|papers with code|cvf open access)(?:\s.*)?$/i, '')
    .trim();
  const variants = [title];
  const split = /^([^:：]{2,32})[:：]\s*(.+)$/.exec(title);
  // Some indexes prepend the method's acronym to the full title. Only a
  // compact identifier can be removed, not a descriptive prefix such as
  // "A Review of" or "An Analysis of" that names a different publication.
  if (split && /^[\p{L}\p{N}._+\- ]+$/u.test(split[1])
    && /[a-z][A-Z]|[A-Z].*\d|^[A-Z][A-Z\d _-]+$/.test(split[1])
    && !/\b(?:review|analysis|survey|comment|reply|erratum|correction|revisit|revisiting|evaluation)\b/i.test(split[1])) variants.push(split[2]);
  return variants.map(variant => tokens(variant, true)).filter(words => words.length >= 3).map(words => words.join(' '));
}
function titleMatches(target, candidate) {
  const identities = titleIdentities(target);
  // Word overlap establishes topical similarity, not publication identity.
  // Preserve token order and every substantive title word, including a sequel
  // version or a review/analysis qualifier. Punctuation and plural variants are
  // normalized by tokens(); actual page content remains a separate concern.
  return titleIdentities(candidate).some(identity => identities.includes(identity));
}
function topicMatches(query, keywords, title, snippet) {
  const titleWords = new Set(tokens(title)), evidence = new Set(tokens(`${title} ${snippet}`));
  const queryWords = tokens(query), keywordWords = [...new Set(keywords.flatMap(value => tokens(value)))];
  const has = word => evidence.has(word);
  const languages = words => [words.filter(word => /^[a-z\d]+$/.test(word)), words.filter(word => !/^[a-z\d]+$/.test(word))].filter(group => group.length);
  const enough = words => words.length && words.filter(has).length >= Math.ceil(words.length * 0.7);
  const queryFits = languages(queryWords).some(enough);
  const keywordFits = languages(keywordWords).some(enough);
  const queryHasEvidenceLanguage = queryWords.some(word => /^[a-z\d]+$/.test(word)) === /[a-z]/i.test(`${title} ${snippet}`);
  if (queryHasEvidenceLanguage && !queryFits) return false;
  if (keywordWords.length && !keywordFits) return false;
  if (!queryFits && !keywordFits) return false;
  const matched = [...new Set([...queryWords, ...keywordWords])].filter(has);
  if (!matched.some(word => titleWords.has(word))) return false;
  // A short acronym or a broad technical noun alone cannot resolve a subject.
  return matched.length >= 2 || matched.some(word => word.length >= 8 && !BROAD_WORDS.has(word));
}

// Only URLs returned by an actual search provider can become result actions.
// An empty legacy reference lookup has no provider health information; it is
// never sufficient by itself to claim that an online search succeeded.
export async function findOnlinePapers({ query, keywords = [], titles = [], mode = 'auto', signal, fetcher = globalThis.fetch, timeoutMs = 18000 } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (q.length < 2) throw new Error('A paper query is required.');
  const searchKeywords = uniqueText(keywords, 6), targetTitles = uniqueText(titles, 4).filter(title => tokens(title, true).length >= 3);
  const known = mode !== 'topic' && targetTitles.length > 0;
  const academicQuery = known ? targetTitles[0] : combineQuery([q, ...searchKeywords]);
  const webQuery = combineQuery([known ? targetTitles[0] : '', q, ...searchKeywords, 'paper']);
  const lookup = async (route, provider) => {
    try {
      const data = await runWithDeadline(async requestSignal => {
        const response = await fetcher(route, { signal: requestSignal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (result.error) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || 'Search unavailable');
        return result;
      }, { signal, timeoutMs });
      return { provider, ok: true, data };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      return { provider, ok: false, error: String(error?.message || error) };
    }
  };
  const responses = await Promise.all([
    lookup(`/api/ref-search?q=${encodeURIComponent(academicQuery)}&scope=reading`, 'academic'),
    lookup(`/api/web-search?q=${encodeURIComponent(webQuery)}&n=8`, 'web'),
  ]);
  if (signal?.aborted) throw signal.reason || new DOMException('Stopped', 'AbortError');
  const rows = new Map();
  const rejectedReasons = { invalid: 0, source: 0, relevance: 0 };
  for (const response of responses) {
    for (const raw of (Array.isArray(response.data?.results) ? response.data.results : []).slice(0, 100)) {
      if (!raw || typeof raw !== 'object') { rejectedReasons.invalid++; continue; }
      const title = clean(raw.title, 500), snippet = clean(raw.snippet, 4000);
      if (!title || (!safePaperLink(raw.url) && !safePaperLink(raw.pdfUrl))) { rejectedReasons.invalid++; continue; }
      const links = sourceLinks(raw, response.provider);
      if (!links) { rejectedReasons.source++; continue; }
      if (!(known ? targetTitles.some(target => titleMatches(target, title)) : topicMatches(q, searchKeywords, title, snippet))) {
        rejectedReasons.relevance++; continue;
      }
      const link = links.url;
      const key = link.replace(/#.*$/, '').replace(/\/$/, '');
      const prior = rows.get(key);
      const item = { title, ...links,
        snippet: snippet.slice(0, 700), year: String(raw.year || '').slice(0, 8),
        source: String(raw.source || raw.provider || response.data?.provider || new URL(link).hostname).slice(0, 100) };
      rows.set(key, prior ? { ...prior, pdfUrl: prior.pdfUrl || item.pdfUrl, snippet: prior.snippet || item.snippet } : item);
    }
  }
  const results = [...rows.values()].slice(0, 8);
  const failures = responses.filter(response => !response.ok);
  const healthy = responses.some(response => response.ok && (response.provider === 'web' || response.data?.results?.length));
  return { status: results.length || healthy ? (failures.length ? 'partial' : 'complete') : 'failed',
    results, rejectedCount: Object.values(rejectedReasons).reduce((sum, count) => sum + count, 0), rejectedReasons,
    searchQueries: { academic: academicQuery, web: webQuery },
    ...(failures.length || !healthy ? { error: 'Search providers did not all respond successfully.' } : {}) };
}
