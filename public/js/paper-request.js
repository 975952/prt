/** A narrow navigation intent. Content questions keep the full reading agent. */
const clean = (value, limit = 2000) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, limit);
const PAPER_NOUN = /(?:论文|文献|文章|预印本|\.pdf\b|《[^》]+》|\b(?:papers?|articles?|preprints?|publications?)\b)/i;
const CONTENT_REQUEST = /(?:解释|讲解|讲讲|讲一下|讲下|讲一讲|分析|总结|概括|梳理|介绍|比较|对比|区别|异同|证明|推导|计算|解答|说明|翻译|复现|实现|代码|为什么|为何|怎么|如何|什么意思|是什么|做了什么|讲的什么|有什么贡献|有什么创新|摘要|引言|结论|公式|定理|页码|哪一?页|第\s*[\d一二三四五六七八九十]+\s*(?:页|章|节)|图\s*[\d一二三四五六七八九十]+|表\s*[\d一二三四五六七八九十]+|带我读|逐步读|阅读路线|(?:论文|文献|文章)(?:里|中|内)|(?:论文|文献|文章)的.{0,16}(?:部分|段落|章节|内容|正文|定义|方法|实验|指标|结果|原理|机制|架构)|\b(?:explain|summari[sz]e|summary|compare|comparison|versus|vs\.?|difference|differences|contrast|analy[sz]e|analysis|derive|derivation|prove|proof|calculate|compute|translate|implement|implementation|reproduce|tell|describe|discuss|teach|why|how|what|introduction|abstract|conclusion|equations?|formulas?|theorems?|figures?|tables?|sections?|pages?)\b|\b(?:in|inside|within)\s+(?:this|that|the)\s+(?:paper|article)\b|\b(?:paper|article)(?:'s)?\s+(?:method|approach|architecture|experiment|result|metric)\b)/i;
const NAVIGATION = /(?:找|寻找|搜|检索|推荐|打开|查看|看看|想看|想读|阅读|下载|给我|发我|有没有|哪一?篇|列出|\b(?:find|search|locate|recommend|open|show|read|download|get|list)\b|\blook\s+for\b|\b(?:want|need)\s+(?:to\s+read|to\s+see|a|the|that|this)\b)/i;

export function isPaperNavigationRequest(question, { hasAttachments = false, previousDiscovery = false } = {}) {
  if (hasAttachments) return false;
  const original = clean(question);
  if (!original) return false;
  // "Just the paper, no explanation" is still navigation. Remove only explicit
  // refusals of extra exposition, never an affirmative content question.
  const text = original
    .replace(/(?:不要|别|无需|不用|不需要|不必)(?:再|继续)?(?:解释|讲解|讲内容|讲原理|分析|总结|展开|介绍|比较|对比|废话)(?:了|内容)?/g, '')
    .replace(/\b(?:no|without|don['’]t|do not|stop)(?:\s+more)?\s+(?:explanations?|explaining|summaries|summari[sz]ing|details?|analysis)\b/gi, '');
  // A quoted title is data, not an instruction to analyse/describe its subject.
  // Keep testing the surrounding request so "find 《…》 and explain it" still
  // goes to the reading agent instead of silently dropping the explanation.
  const instructions = text.replace(/《[^》\n]+》|“[^”\n]+”|"[^"\n]+"/g, ' ');
  if (CONTENT_REQUEST.test(instructions)) return false;
  if (/(?:不(?:想|要|用|必|需)?(?:再)?(?:找|搜|打开|看)|不是.{0,8}(?:找|搜))/.test(text)
    || /\b(?:don['’]t|do not|stop)\s+(?:find|finding|search|searching|open|opening)\b/i.test(text)) return false;
  const correction = /(?:只|就).{0,10}(?:那|这|同一|一).{0,3}篇(?:论文|文章)?|(?:那|这)一?篇(?:就够|即可|就好|就行)/.test(text)
    || /\b(?:just|only)\s+(?:(?:want|need)\s+)?(?:that|this|the same|one)\s+(?:paper|article|one)\b/i.test(text)
    || /^(?:[?？!！。,.\s]*)(?:打开|查看|下载)(?:它|这篇|那篇)(?:吧|就行)?[?？!！。,.\s]*$/.test(text)
    || /^\s*(?:open|show|download)\s+(?:it|that|this)(?:\s+(?:paper|article))?\s*[.!?]*$/i.test(text);
  if (correction) return !!previousDiscovery;
  return PAPER_NOUN.test(text) && NAVIGATION.test(text);
}

function textList(value, count, length) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).filter(item => typeof item === 'string')
    .map(item => clean(item, length)).filter(item => {
      const key = item.toLocaleLowerCase();
      if (item.length < 2 || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, count);
}
function multiplePapersRequested(question) {
  const text = clean(question);
  if (/(?:只|仅|就).{0,8}(?:一|那一?|这一?)篇|\b(?:just|only)\s+(?:(?:want|need)\s+)?(?:(?:that|this|one|a single)\s+)?(?:paper|article)\b/i.test(text)) return false;
  return /(?:[两二三四五六七八九十几多若干]\s*篇|(?:[2-9]|\d{2,})\s*篇|一组(?:论文|文献)|一些(?:论文|文献)|多份(?:论文|文献)|分别.{0,40}(?:论文|文献))/i.test(text)
    || /\b(?:papers|articles|preprints|publications)\b/i.test(text);
}

export function normalizePaperSearchPlan(raw, question) {
  const fallback = () => ({ queries: [{ query: clean(question, 200), keywords: [], titles: [], aliases: [], mode: 'auto' }], reliable: false });
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); }
    catch { return fallback(); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback();
  const multiple = multiplePapersRequested(question);
  // Invalid first plans must not silently promote an unsolicited alternative.
  const candidates = (Array.isArray(parsed.queries) ? parsed.queries : [parsed]).slice(0, multiple ? 4 : 1);
  const queries = candidates.flatMap(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.query !== 'string') return [];
    const query = clean(row.query, 200);
    if (query.length < 2) return [];
    return [{ query, keywords: textList(row.keywords, 6, 100),
      // A query names one work; alternate works belong in separate explicitly
      // requested queries. Short aliases remain separate from its full title.
      titles: textList(row.titles, 1, 200), aliases: textList(row.aliases, 6, 100),
      mode: ['auto', 'known', 'topic'].includes(row.mode) ? row.mode : 'auto' }];
  });
  return queries.length ? { queries, reliable: parsed.reliable !== false } : fallback();
}

export const PAPER_SEARCH_PLAN_PROMPT = `PAPER_DISCOVERY_QUERY_PLAN
Convert the user's paper-finding request into a concise search plan. Return JSON only:
{"queries":[{"query":"specific title or topic with its disambiguating context","mode":"known|topic|auto","titles":["one complete canonical title, if known"],"aliases":["alternate names of the SAME work"],"keywords":["distinctive term or phrase","useful synonym"]}]}
Use mode known for one identifiable paper, topic for a request for research on a subject, and auto when identity is uncertain.
For a request for one paper, return exactly one query and at most one canonical title. Do not add other papers, follow-ups, popular related papers, or alternate expansions of an acronym the user did not request. Correcting you with "only that paper" narrows the previous target; it does not ask for new alternatives. Use earlier context only to resolve that target.
Only an explicit request for multiple papers allows up to four queries. Each query still names one target or one coherent topic. Keep query and title under 200 characters, and use at most six short keywords and six aliases.
Preserve the full identifying title, method name, domain and version. Do not reduce a qualified request to a bare ambiguous acronym. Aliases must denote the same work, not a different work sharing an abbreviation. For topic searches, use discriminative subject terms and useful English/Chinese equivalents without inventing a specific paper.
Titles supplied from model knowledge are provisional search candidates, never evidence that a file exists or that a paper was found. The program verifies local and online evidence. Do not invent URLs, filenames, authors, results, summaries, reading advice, or claims of successful discovery.`;
