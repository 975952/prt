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

// Only URLs returned by an actual search provider can become result actions.
// An empty legacy reference lookup has no provider health information; it is
// never sufficient by itself to claim that an online search succeeded.
export async function findOnlinePapers({ query, signal, fetcher = globalThis.fetch, timeoutMs = 18000 } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (q.length < 2) throw new Error('A paper query is required.');
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
    lookup(`/api/ref-search?q=${encodeURIComponent(q)}&scope=reading`, 'academic'),
    lookup(`/api/web-search?q=${encodeURIComponent(`${q} paper`.slice(0, 200))}&n=8`, 'web'),
  ]);
  if (signal?.aborted) throw signal.reason || new DOMException('Stopped', 'AbortError');
  const rows = new Map();
  for (const response of responses) {
    for (const raw of Array.isArray(response.data?.results) ? response.data.results : []) {
      const url = safePaperLink(raw.url), pdfUrl = safePaperLink(raw.pdfUrl);
      const title = String(raw.title || '').trim().slice(0, 500);
      if (!title || (!url && !pdfUrl)) continue;
      const link = url || pdfUrl;
      const key = link.replace(/#.*$/, '').replace(/\/$/, '');
      const prior = rows.get(key);
      const item = { title, url: link, pdfUrl: pdfUrl || (/\.pdf(?:[?#]|$)/i.test(link) ? link : ''),
        snippet: String(raw.snippet || '').slice(0, 700), year: String(raw.year || '').slice(0, 8),
        source: String(raw.source || raw.provider || response.data?.provider || new URL(link).hostname).slice(0, 100) };
      rows.set(key, prior ? { ...prior, pdfUrl: prior.pdfUrl || item.pdfUrl, snippet: prior.snippet || item.snippet } : item);
    }
  }
  const results = [...rows.values()].slice(0, 8);
  const failures = responses.filter(response => !response.ok);
  const healthy = responses.some(response => response.ok && (response.provider === 'web' || response.data?.results?.length));
  return { status: results.length || healthy ? (failures.length ? 'partial' : 'complete') : 'failed',
    results, ...(failures.length || !healthy ? { error: 'Search providers did not all respond successfully.' } : {}) };
}
