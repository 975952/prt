/** Resolve explicit local files independently of the visible PDF. Paths and
 * filenames outrank titles; aliases must not guess editions or duplicates. */
const fold = value => String(value || '').normalize('NFKC').toLowerCase();
const normalize = value => fold(value).replace(/\.pdf\b/g, '').replace(/[^\p{L}\p{N}]/gu, '');
const identity = paper => fold(paper?.path || paper?.name || paper?.docId || '').replace(/\\/g, '/');
const sourceSeparator = /\s*(?:和|与|及|以及|、|，|,|;|；|\b(?:and|with|versus|vs\.?|against)\b)\s*/i;
const escapeRe = value => String(value).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
const generic = /^(?:(?:这|那|当前|上|下|前|后|刚才)(?:一)?(?:本|篇|个|页)?(?:论文|教材|课本|文件|文档|书)?|一|本|篇|论文|教材|课本|文件|文档|书|paper|book|textbook|this|that|current|the|thispaper|thisbook|thispage|thatpaper|thatbook)$/i;
function chineseInteger(value) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[零〇一二两三四五六七八九]+$/.test(value)) return Number([...value].map(x => digits[x]).join(''));
  let total = 0, section = 0, digit = 0;
  for (const char of value) {
    if (char in digits) digit = digits[char];
    else if (char === '万') { total += (section + digit || 1) * 10000; section = digit = 0; }
    else { const unit = { 十: 10, 百: 100, 千: 1000 }[char]; if (!unit) return NaN; section += (digit || 1) * unit; digit = 0; }
  }
  return total + section + digit;
}
function pageIn(value) {
  const match = fold(value).match(/(?<![上下前后这那每零〇一二两三四五六七八九十百千万])第?\s*([+\-−]?(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+))\s*页|\b(?:pages?|p\.?)\s*[#:]?\s*([+\-−]?\d+(?:\.\d+)?)\b/i);
  if (!match) return { page: null, requested: false };
  const token = match[1] || match[2], sign = /^[\-−]/.test(token) ? -1 : 1;
  const unsigned = token.replace(/^[+\-−]/, '');
  const page = sign * (/^\d/.test(unsigned) ? Number(unsigned) : chineseInteger(unsigned));
  return { page: Number.isFinite(page) ? page : null, requested: true,
    ...(!Number.isSafeInteger(page) || page < 1 ? { invalidPage: true, pageError: '页码必须是大于 0 的整数' } : {}) };
}
function editionIn(value) {
  const match = fold(value).match(/第\s*([\d零〇一二两三四五六七八九十百]+)\s*版|\b(\d+)(?:st|nd|rd|th)?\s*(?:edition|ed\.)\b|\b(?:edition|ed\.)\s*(\d+)\b/);
  if (!match) return null;
  const token = match[1] || match[2] || match[3];
  return /^\d/.test(token) ? Number(token) : chineseInteger(token);
}
function namedPhrase(question) {
  return String(question || '').replace(/(?:下一页|上一页|后一页|前一页|\b(?:next|previous) page\b)[\s\S]*$/i, '')
    .replace(/第?\s*[+\-−]?(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)\s*页[\s\S]*$|\b(?:pages?|p\.?)\s*[#:]?\s*[+\-−]?\d+(?:\.\d+)?\b[\s\S]*$/i, '')
    .replace(/^(?:(?:请|帮我|给我|麻烦|能否|能不能|详细|please)\s*)+/i, '')
    .replace(/^(?:讲一讲|讲讲|讲解|解释|说明|读一下|读取|总结|概括|看看|看|讲|读|打开|explain|summari[sz]e|read|describe|open)(?:一下|一讲|讲|下)?\s*/i, '')
    .replace(/^(?:从|在|关于|the\s+)/i, '')
    .replace(/(?:(?:里面|中的|里的|上|内|中|里|的)\s*)+$|\s+\b(?:in|of|from)\s*$/i, '')
    .replace(/(?:教科书|教材|课本|论文|文档|文件|书|\btextbook|\bpaper|\bbook)\s*$/i, '').trim();
}
function aliases(paper) {
  const out = new Map();
  const add = (raw, tier) => {
    const key = normalize(raw);
    if (key.length < 2 || generic.test(key)) return;
    const prior = out.get(key);
    if (!prior || prior.tier < tier) out.set(key, { raw: String(raw), key, tier });
  };
  for (const value of [paper.name, paper.title, paper.displayTitle, paper.label].filter(Boolean)) {
    const stem = String(value).replace(/\.pdf$/i, '').split(/[\\/]/).at(-1);
    const full = stem.replace(/(?:[_-]\d{1,3}|\s*\(\d{1,3}\))$/, '').trim();
    add(stem, 300); add(full, 280);
    for (const part of full.split(/\s*[·：:]\s*/)) add(part, 260);
    const base = full.replace(/第\s*[\d零〇一二两三四五六七八九十百]+\s*版[\s\S]*$|\b\d+(?:st|nd|rd|th)?\s*(?:edition|ed\.)[\s\S]*$|\b(?:edition|ed\.)\s*\d+[\s\S]*$/i, '').trim();
    if (base !== full) add(base, 180);
  }
  return [...out.values()];
}
function mentions(raw, alias) {
  if (/^(?:arxiv[ _:-]*)?\d{4}\.\d{4,5}(?:v\d+)?$/i.test(alias.raw)) {
    const id = alias.raw.replace(/^arxiv[ _:-]*/i, '');
    return new RegExp('(?<![\\d.])' + escapeRe(id) + '(?![\\d.a-z])', 'i').test(raw);
  }
  if (/^\d+$/.test(alias.key)) return false;
  if (/[\u3400-\u9fff]/.test(alias.raw)) return normalize(raw).includes(alias.key);
  const tokens = fold(alias.raw).match(/[a-z\d]+/g) || [];
  if (!tokens.length) return false;
  return new RegExp('(?<![a-z\\d])' + tokens.map(escapeRe).join('[\\s_\\-:·]+') + '(?![a-z\\d])', 'i').test(raw);
}
function rangesFor(raw, value, tier) {
  const tokens = fold(value).match(/[\p{L}\p{N}]+/gu) || [];
  if (!tokens.length) return [];
  const boundary = /^[a-z\d]/i.test(tokens[0]) ? '(?<![a-z\\d])' : '';
  const tail = /[a-z\d]$/i.test(tokens.at(-1)) ? '(?![a-z\\d])' : '';
  const re = new RegExp(boundary + tokens.map(escapeRe).join('[^\\p{L}\\p{N}]*') + tail, 'giu');
  return [...fold(raw).matchAll(re)].map(match => ({ start: match.index, end: match.index + match[0].length, tier }));
}
export function resolvePaperTarget({ question, papers = [], currentDocId = '', currentPath = '', currentPage = null, previousTarget = null } = {}) {
  const raw = String(question || '').trim(), normalized = normalize(raw), folded = fold(raw);
  const pageState = pageIn(raw), { page } = pageState;
  const phraseRaw = namedPhrase(raw), phrase = normalize(phraseRaw);
  const rows = papers.filter(paper => paper && paper.url && paper.name);
  const isCrossFile = paper => currentPath ? identity(paper) !== identity({ path: currentPath })
    : String(paper.docId || '') !== String(currentDocId) || rows.filter(row => row.docId === currentDocId).length > 1;
  const quotes = [...raw.matchAll(/《([^》]{1,200})》|[「“"]([^」”"]{1,200})[」”"]/g)]
    .map(match => ({ value: match[1] || match[2], title: !!match[1] }));
  const editionMentions = [...raw.matchAll(/第\s*[\d零〇一二两三四五六七八九十百]+\s*版|\b\d+(?:st|nd|rd|th)?\s*(?:edition|ed\.)/gi)];
  const requestedEdition = editionMentions.length > 1 ? null : editionIn(raw);
  const relative = /下一页|后一页|\bnext page\b/i.test(raw) ? 1 : /上一页|前一页|\bprevious page\b/i.test(raw) ? -1 : 0;
  const docMarker = /教科书|教材|课本|论文|文档|文件|书|\b(?:textbook|paper|book|file|document)\b|\.pdf\b/i.test(raw);
  const readAction = /^(?:请|帮我|please\s+)?\s*(?:读|读取|打开|read\b|open\b)/i.test(raw);
  const context = docMarker || pageState.requested || relative || readAction || quotes.some(quote => quote.title);
  const baseResult = extra => ({ page, ...(!pageState.invalidPage ? {} : { invalidPage: true, pageError: pageState.pageError }), ...extra });
  const scored = [];
  for (const paper of rows) {
    let tier = 0;
    const claims = [];
    const paths = [paper.path, paper.folder ? paper.folder + '/' + paper.name : ''].filter(value => value && /[\\/]/.test(value));
    for (const value of paths) if (folded.replace(/\\/g, '/').includes(fold(value).replace(/\\/g, '/'))) {
      tier = 600; claims.push(...rangesFor(raw, value, 600));
    }
    const file = fold(paper.name);
    if (file.endsWith('.pdf') && new RegExp('(?<![a-z\\d])' + escapeRe(file) + '(?![a-z\\d])', 'i').test(folded)) {
      tier = Math.max(tier, 500); claims.push(...rangesFor(raw, file, 500));
    }
    for (const alias of aliases(paper)) {
      const quoted = quotes.some(quote => normalize(quote.value) === alias.key);
      const numeric = /^\d+$/.test(fold(alias.raw));
      if (quoted && (!numeric || /\.pdf\b/i.test(raw) || docMarker)) {
        tier = Math.max(tier, alias.tier); claims.push(...rangesFor(raw, alias.raw, alias.tier));
      }
      if (!numeric && mentions(raw, alias)) {
        const shortChinese = /^[\u3400-\u9fff]{2,3}$/.test(alias.key);
        const shortEnglish = /^[a-z\d]+$/i.test(alias.raw) && !/^\d{4}\.\d/.test(alias.raw);
        const phraseMatches = phrase === alias.key || normalize(phraseRaw.replace(/(?:教科书|教材|课本|书)/g, '')) === alias.key;
        if (shortChinese ? phraseMatches && (context || normalized === alias.key)
          : shortEnglish ? context || normalized === alias.key : true) {
          const score = shortChinese ? Math.min(180, alias.tier) : alias.tier;
          tier = Math.max(tier, score); claims.push(...rangesFor(raw, alias.raw, score));
        }
      }
      const partial = /^[\u3400-\u9fff]{4,}$/.test(phrase) || (phrase.length >= 8 && phraseRaw.trim().split(/\s+/).length >= 2);
      if (context && partial && !generic.test(phrase) && alias.key.includes(phrase)) tier = Math.max(tier, 100);
    }
    if (!tier) continue;
    const edition = editionIn(paper.name + ' ' + (paper.title || '') + ' ' + (paper.displayTitle || ''));
    const localEditions = claims.map(claim => editionIn(raw.slice(claim.start, claim.end)
      + raw.slice(claim.end).split(sourceSeparator)[0])).filter(value => value !== null);
    // An edition belongs to its named book, not every other file in a comparison.
    const requiredEdition = localEditions[0] ?? (claims.length ? null : requestedEdition);
    if (requiredEdition !== null && edition !== requiredEdition && tier < 500) continue;
    scored.push({ paper, tier, claims });
  }
  if (scored.length) {
    const namedFileEnds = [...raw.matchAll(/\.pdf\b/gi)];
    const unknownFile = namedFileEnds.find(match => !scored.some(row => row.claims.some(claim => claim.start <= match.index && claim.end >= match.index + match[0].length)));
    if (unknownFile) {
      const query = raw.slice(0, unknownFile.index + unknownFile[0].length).split(sourceSeparator).at(-1).trim();
      return baseResult({ status: 'missing', query, candidates: [], explicit: true });
    }
    // Distinct named references are multiple requested sources. Overlapping
    // names are one reference: a full path outranks its basename, while two
    // same-name files remain ambiguous rather than being guessed by docId.
    const claims = scored.flatMap(row => row.claims.map(claim => ({ ...claim, paper: row.paper })))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const groups = [];
    for (const claim of claims) {
      const group = groups.at(-1);
      if (group && claim.start < group.end) { group.end = Math.max(group.end, claim.end); group.claims.push(claim); }
      else groups.push({ start: claim.start, end: claim.end, claims: [claim] });
    }
    if (groups.length > 1) {
      const targets = [], ambiguous = [];
      const pageMentions = [...raw.matchAll(/第?\s*[+\-−]?(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)\s*页|\b(?:pages?|p\.?)\s*[#:]?\s*[+\-−]?\d+(?:\.\d+)?\b/gi)];
      const sharedPage = pageMentions.length === 1 ? pageState : { page: null, requested: false };
      for (const [index, group] of groups.entries()) {
        const best = Math.max(...group.claims.map(claim => claim.tier));
        const candidates = [...new Map(group.claims.filter(claim => claim.tier === best).map(claim => [identity(claim.paper), claim.paper])).values()];
        if (candidates.length > 1) ambiguous.push(...candidates);
        else {
          const after = raw.slice(group.end, groups[index + 1]?.start ?? raw.length).split(sourceSeparator)[0];
          const before = raw.slice(groups[index - 1]?.end ?? 0, group.start).split(sourceSeparator).at(-1);
          const afterPage = pageIn(after), beforePage = pageIn(before);
          const assigned = afterPage.requested ? afterPage : beforePage.requested ? beforePage : sharedPage;
          targets.push(...candidates.map(paper => ({ paper, page: assigned.page,
            ...(assigned.invalidPage ? { invalidPage: true, pageError: assigned.pageError } : {}) })));
        }
      }
      if (ambiguous.length) return baseResult({ status: 'ambiguous', candidates: [...new Map(ambiguous.map(paper => [identity(paper), paper])).values()], explicit: true });
      const distinctTargets = [...new Map(targets.map(target => [identity(target.paper), target])).values()];
      if (distinctTargets.length > 1) return baseResult({ status: 'multiple', papers: distinctTargets.map(target => target.paper),
        candidates: distinctTargets.map(target => target.paper), targets: distinctTargets,
        page: sharedPage.page, explicit: true, inherited: false,
        ...(distinctTargets.some(target => target.invalidPage) ? { invalidPage: true, pageError: '页码必须是大于 0 的整数' } : {}) });
    }
    const top = Math.max(...scored.map(row => row.tier)), best = scored.filter(row => row.tier === top);
    const distinct = [...new Map(best.map(row => [identity(row.paper), row.paper])).values()];
    if (distinct.length > 1) return baseResult({ status: 'ambiguous', candidates: distinct, explicit: true });
    const paper = distinct[0];
    const priorPage = previousTarget && identity(previousTarget) === identity(paper) ? previousTarget.page : !isCrossFile(paper) ? currentPage : null;
    const next = !pageState.requested && relative ? (Number.isInteger(priorPage) ? priorPage + relative : null) : page;
    return baseResult({ status: 'matched', paper, page: next, explicit: true, inherited: false, crossFile: isCrossFile(paper),
      ...(!pageState.requested && relative && (!Number.isSafeInteger(next) || next < 1) ? { invalidPage: true, pageError: next === null ? '请先指定要继续阅读的页码' : '页码必须是大于 0 的整数' } : {}) });
  }
  const pageOnly = pageState.requested && (!phrase || generic.test(phrase) || /^(?:那|那么|然后|再|再看|那再看|then|and|whatabout)$/i.test(phrase));
  const follow = relative || pageOnly || /^(?:那(?:篇|本|个)|刚才|上一个|上一轮|这(?:个|段|部分)|继续|接着|详细|再讲|为什么|为何|没懂|不懂|\?|？)|\b(?:that (?:paper|book|page)|continue|explain more|why|what about)\b/i.test(raw);
  const screen = /当前|这一?页|本页|这篇|这本|眼前|屏幕|\bcurrent\b|\bthis (?:page|paper|book|document)\b|\bon screen\b/i.test(raw);
  const namedQuote = quotes.find(quote => quote.title || /\.pdf$/i.test(quote.value));
  const hasExplicitName = !!namedQuote || /\.pdf\b/i.test(raw)
    || (pageState.requested && (docMarker || requestedEdition !== null) && phrase.length >= 2 && !generic.test(phrase) && !screen && !/^(?:那|刚才|上一)/.test(phrase));
  if (hasExplicitName) return baseResult({ status: 'missing', query: namedQuote?.value || phraseRaw || raw, candidates: [], explicit: true });
  if (relative && (screen || !previousTarget)) {
    const current = currentPath ? rows.filter(row => identity(row) === identity({ path: currentPath })) : rows.filter(row => row.docId === currentDocId);
    if (current.length > 1) return baseResult({ status: 'ambiguous', candidates: current, explicit: false });
    if (current.length === 1) {
      const next = Number.isInteger(currentPage) ? currentPage + relative : null;
      return baseResult({ status: 'matched', paper: current[0], page: next, explicit: false, inherited: false, crossFile: false,
        ...(!Number.isSafeInteger(next) || next < 1 ? { invalidPage: true, pageError: next === null ? '请先指定要继续阅读的页码' : '页码必须是大于 0 的整数' } : {}) });
    }
  }
  if (previousTarget && follow && !screen) {
    const priorMatches = previousTarget.path ? rows.filter(row => identity(row) === identity(previousTarget)) : rows.filter(row => row.docId === previousTarget.docId);
    if (priorMatches.length > 1) return baseResult({ status: 'ambiguous', candidates: priorMatches, explicit: false, inherited: true });
    const paper = priorMatches[0];
    if (!paper) return baseResult({ status: 'missing', query: previousTarget.name || previousTarget.path || '', candidates: [], explicit: false, inherited: true });
    let next = pageState.requested ? page : previousTarget.page ?? null;
    if (!pageState.requested && relative) next = Number.isInteger(previousTarget.page) ? previousTarget.page + relative : null;
    const invalid = pageState.invalidPage || (relative && (!Number.isSafeInteger(next) || next < 1));
    return baseResult({ status: 'matched', paper, page: next, explicit: false, inherited: true,
      ...(invalid ? { invalidPage: true, pageError: next === null ? '请先指定要继续阅读的页码' : '页码必须是大于 0 的整数' } : {}),
      crossFile: isCrossFile(paper) });
  }
  return baseResult({ status: 'none', explicit: false });
}
export function snapshotPaperTarget(paper, page = null) {
  if (!paper || !paper.docId) return null;
  return { docId: String(paper.docId).slice(0, 240), name: String(paper.name || '').slice(0, 300),
    path: String(paper.path || paper.name || '').slice(0, 800), page: Number.isSafeInteger(page) && page > 0 ? page : null };
}
