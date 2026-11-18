import { t as tr } from './i18n.js';
/* 小工具集合 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function debounce(fn, ms = 200) {
  let t = null;
  let lastArgs = null;
  const wrapped = (...a) => {
    lastArgs = a;
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...a); }, ms);
  };
  wrapped.cancel = () => { clearTimeout(t); t = null; };
  /** 立刻执行还没触发的那一次（关页面前落盘用） */
  wrapped.flush = () => {
    if (!t) return false;
    clearTimeout(t);
    t = null;
    fn(...(lastArgs || []));
    return true;
  };
  return wrapped;
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let timer = null;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...a);
      }, ms - (now - last));
    }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

/* 用户口径（2026-11-02）：右下角的弹出提示**只在出问题时**出现，成功/信息类一律不弹（很影响心情）。
   唯一保留的成功类提示是「结果已经生成 / 已定位过去」这一族；另外「失败/未保存/请重新…」这类
   即使调用方标成 ok 也属于问题，继续显示。 */
const TOAST_KEEP = /已在结果区|已定位过去|已恢复问题|已生成|点「重新生成」|直接用缓存|已翻过|失败|出错|错误|异常|超时|未保存|已不在|请重新|未配置|不可用|无法|丢失|重试|拒绝|断开|过期|无效|不支持|问题|忽略|failed|could not|error|timed out|not saved|missing|retry|unavailable|not supported|restored|existing (result|translation)|saved translation/i;

export function toast(msg, kind = '', ms = 2600) {
  const text = String(msg || '');
  if (kind !== 'err' && kind !== 'error' && !TOAST_KEEP.test(text)) return;
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const node = el('div', { class: `toast ${kind}`, text });
  wrap.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 260);
  }, ms);
}

export function toastAction(msg, label, action, kind = 'err', ms = 7000) {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const retry = async () => {
    try { await action(); }
    catch (e) { toastAction(tr("重试失败：{0}", e?.message || e), label, retry, kind, ms); }
  };
  const node = el('div', { class: `toast ${kind}` }, el('span', { text: msg }), el('button', {
    type: 'button', text: label, onclick: async () => {
      node.remove();
      await retry();
    },
  }));
  wrap.append(node);
  setTimeout(() => node.remove(), ms);
}

/* ---------------------------------------------------------------- 选区清洗 */

/**
 * 论文 PDF 的文本层会把连字符断行、列切换都塞进选区。
 * 这里把选中的原始文本还原成适合翻译/提问的连续文本。
 */
export function cleanText(raw) {
  if (!raw) return '';
  let t = raw.replace(/\r\n?/g, '\n');
  t = t.replace(/[ \t]*\n[ \t]*/g, '\n');          // 去掉行首行尾空白
  t = t.replace(/([A-Za-z])-\n([a-z])/g, '$1$2');   // 处理断词连字符
  t = t.replace(/\n{2,}/g, '\u0000');               // 段落占位
  t = t.replace(/\n/g, ' ');                        // 段内换行变空格
  t = t.replace(/\u0000/g, '\n\n');
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t.trim();
}

const MATH_MAX_LEN = 3000;

export function renderMathToString(tex, display = false) {
  const katex = globalThis.katex;
  const body = String(tex || '').trim();
  if (!katex || !body || body.length > MATH_MAX_LEN) return null;
  try {
    return katex.renderToString(body, {
      displayMode: !!display,
      throwOnError: true,   // 出错抛异常 → 上层退回原文
      strict: 'ignore',
      trust: false,         // 禁掉 \htmlClass 这类越权命令
      maxSize: 12,
    });
  } catch {
    return null;
  }
}

function isTableSep(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** 拆一行单元格。`\|` 是转义过的竖线，不能当分隔符 */
function splitTableRow(line) {
  const raw = String(line || '').trim();
  let body = raw.replace(/^\|/, '');
  if (body.endsWith('|')) {
    const slashes = /\\*$/.exec(body.slice(0, -1))[0].length;
    if (slashes % 2 === 0) body = body.slice(0, -1);
  }
  const cells = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && ['|', '\\'].includes(body[i + 1])) { cur += body[++i]; continue; }
    if (body[i] === '|') { cells.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function renderTable(head, rows, separators, inline) {
  // A malformed model row may contain more cells than its header. Preserve every
  // cell instead of silently truncating values to the header's column count.
  const n = Math.max(1, head.length, ...rows.map((row) => row.length));
  const pad = (arr) => {
    const out = arr.slice();
    while (out.length < n) out.push('');
    return out;
  };
  const align = (index) => {
    const separator = separators[index] || '';
    const value = separator.startsWith(':') && separator.endsWith(':') ? 'center'
      : separator.endsWith(':') ? 'right' : separator.startsWith(':') ? 'left' : '';
    return value ? ` style="text-align:${value}"` : '';
  };
  const th = pad(head).map((c, i) => `<th scope="col"${align(i)}>${inline(c)}</th>`).join('');
  const tb = rows.map((r) => `<tr>${pad(r).map((c, i) => `<td${align(i)}>${inline(c)}</td>`).join('')}</tr>`).join('');
  // 外层 div 管横向滚动：侧栏很窄，宽表格不能把面板撑破
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

/**
 * Local, dependency-free Markdown rendering for reading answers. Block parsing
 * keeps paragraphs, nested lists, quotes and tables structurally separate;
 * model HTML is always escaped. Code and math are protected before Markdown.
 */
export function renderMarkdown(src) {
  if (!src) return '';
  const protectedParts = [];
  const hold = (html, block = false) => {
    protectedParts.push({ html, block });
    return `\u0000${protectedParts.length - 1}\u0000`;
  };
  const restore = (value) => {
    let result = value;
    for (let i = 0; i < 12 && /\u0000\d+\u0000/.test(result); i++) {
      result = result.replace(/\u0000(\d+)\u0000/g, (_, n) => protectedParts[Number(n)]?.html || '');
    }
    return result;
  };
  // Input cannot forge one of the internal, already-escaped placeholders.
  let text = String(src).replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const sourceLines = text.split('\n');
  const prepared = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const opening = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})[ \t]*([^\n]*)$/.exec(sourceLines[i]);
    if (!opening) { prepared.push(sourceLines[i]); continue; }
    const marker = opening[2];
    const close = new RegExp(`^[ \\t]*${marker[0]}{${marker.length},}[ \\t]*$`);
    const prefix = opening[1];
    const quoteDepth = (prefix.match(/>/g) || []).length;
    const indent = quoteDepth ? prefix.slice(prefix.lastIndexOf('>') + 1).replace(/^[ \t]/, '') : prefix;
    const unprefix = (line) => {
      let content = line;
      for (let q = 0; q < quoteDepth; q++) {
        const head = /^[ \t]*>[ \t]?/.exec(content);
        if (!head) return null;
        content = content.slice(head[0].length);
      }
      return content.startsWith(indent) ? content.slice(indent.length) : content;
    };
    let end = i + 1;
    while (end < sourceLines.length && unprefix(sourceLines[end]) !== null && !close.test(unprefix(sourceLines[end]))) end++;
    const closed = end < sourceLines.length && unprefix(sourceLines[end]) !== null;
    const code = sourceLines.slice(i + 1, end).map(unprefix).join('\n');
    const language = opening[3].trim().split(/\s+/)[0];
    const langClass = /^[\w#+.-]{1,40}$/.test(language) ? ` class="language-${escapeHtml(language)}"` : '';
    prepared.push(prefix + hold(`<pre><code${langClass}>${escapeHtml(code)}</code></pre>`, true));
    i = closed ? end : end - 1;
  }
  text = prepared.join('\n');
  // Inline code may contain dollar signs, table separators and Markdown markers.
  text = text.replace(/(`+)([\s\S]*?)\1(?!`)/g, (_, ticks, c) => {
    const code = c.replace(/\n/g, ' ');
    return hold(`<code>${escapeHtml(/^ .* $/.test(code) && /\S/.test(code) ? code.slice(1, -1) : code)}</code>`);
  });
  // 3) 公式。必须在 escapeHtml 之前 —— 否则 $ 和 \ 已经被转义，KaTeX 就认不出来了。
  //    $$ 要在 $ 之前处理，否则 $$x$$ 会被拆成两个行内公式。
  const math = (tex, display, raw) => {
    const html = renderMathToString(tex, display);
    // Failed formulas stay readable and cannot be reparsed as list/table syntax.
    const fallback = display ? `<pre class="math-source">${escapeHtml(raw)}</pre>` : escapeHtml(raw);
    return hold(html === null ? fallback : html, display);
  };
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (raw, tex) => math(tex, true, raw));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (raw, tex) => math(tex, true, raw));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (raw, tex) => math(tex, false, raw));
  // 行内公式用 pandoc 的规矩：开头的 $ 右边不能是空格、结尾的 $ 左边不能是空格、
  // 后面不能紧跟数字。不然「价格是 $5 到 $10」里的两个 $ 会被当成一对公式，
  // 把中间的汉字渲染进公式里、还把 $ 吃掉。
  text = text.replace(/\$(?![\s$])([^\n$]*?[^\s$])\$(?!\d)/g, (raw, tex) => math(tex, false, raw));

  const inline = (value, links = true) => {
    let raw = value;
    if (links) {
      raw = raw.replace(/(?<!!)\[([^\]\n]+)\]\(\s*(<[^<>\n]+>|[^\s()]+(?:\([^()\s]*\)[^\s()]*)*)(?:\s+["']([^"'\n]*)["'])?\s*\)/g,
        (original, label, destination, title) => {
          const url = destination.replace(/^<|>$/g, '');
          if (/[\u0000-\u0020\u007f]/.test(url)) return original;
          let parsed;
          try { parsed = new URL(url); } catch { return original; }
          if (!['http:', 'https:'].includes(parsed.protocol)) return original;
          const tip = title ? ` title="${escapeHtml(title)}"` : '';
          return hold(`<a href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer"${tip}>${inline(label, false)}</a>`);
        });
    }
    raw = raw.replace(/\\([\\`*{}\[\]()#+\-.!_|>])/g, (_, char) => hold(escapeHtml(char)));
    // Let HTML decode complete character references once, after Markdown parsing.
    // Protecting the reference itself keeps encoded tags and Markdown punctuation
    // as text; code/math were already protected and must retain their literals.
    raw = raw.replace(/&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (entity) => hold(entity));
    return restore(escapeHtml(raw)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\n/g, '<br />'));
  };
  const markerOf = (line) => {
    const match = /^( *)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line || '');
    if (!match) return null;
    return { indent: match[1].length, kind: /^\d/.test(match[2]) ? 'ol' : 'ul',
      number: parseInt(match[2], 10), content: match[4],
      contentIndent: match[1].length + match[2].length + match[3].length };
  };
  const blockToken = (line) => {
    const match = /^\s*\u0000(\d+)\u0000\s*$/.exec(line || '');
    return match && protectedParts[Number(match[1])]?.block ? Number(match[1]) : null;
  };
  const heading = (line) => /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line || '');
  const quote = (line) => /^ {0,3}>[ \t]?(.*)$/.exec(line || '');
  const rule = (line) => /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line || '');
  const tableAt = (lines, i) => lines[i]?.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]);
  const startsBlock = (lines, i) => !!(markerOf(lines[i]) || heading(lines[i]) || quote(lines[i])
    || rule(lines[i]) || blockToken(lines[i]) !== null || tableAt(lines, i));
  const paragraph = (lines) => {
    // Display math in the middle of a sentence remains an independent block.
    const segments = lines.join('\n').split(/(\u0000\d+\u0000)/);
    const result = [];
    let pending = '';
    const flush = () => { if (pending.trim()) result.push(`<p>${inline(pending.trim())}</p>`); pending = ''; };
    for (const part of segments) {
      const token = blockToken(part);
      if (token === null) pending += part;
      else { flush(); result.push(protectedParts[token].html); }
    }
    flush();
    return result.join('\n');
  };
  const parseBlocks = (lines, depth = 0) => {
    if (depth > 24) return paragraph(lines); // bounded nesting for untrusted output
    const out = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const token = blockToken(line);
      if (token !== null) { out.push(protectedParts[token].html); i++; continue; }
      const title = heading(line);
      if (title) {
        const level = Math.min(6, title[1].length + 2);
        out.push(`<h${level}>${inline(title[2].replace(/[ \t]+#+[ \t]*$/, ''))}</h${level}>`); i++; continue;
      }
      if (rule(line)) { out.push('<hr />'); i++; continue; }
      if (quote(line)) {
        const content = [];
        while (i < lines.length && quote(lines[i])) content.push(quote(lines[i++])[1]);
        out.push(`<blockquote class="md-quote">${parseBlocks(content, depth + 1)}</blockquote>`);
        continue;
      }
      if (tableAt(lines, i)) {
        const head = splitTableRow(line);
        const separators = splitTableRow(lines[i + 1]);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !markerOf(lines[i]) && !quote(lines[i])) {
          rows.push(splitTableRow(lines[i++]));
        }
        out.push(renderTable(head, rows, separators, inline));
        continue;
      }
      const first = markerOf(line);
      if (first) {
        const items = [];
        let expected = first.number;
        while (i < lines.length) {
          const item = markerOf(lines[i]);
          if (!item || item.indent !== first.indent || item.kind !== first.kind) break;
          const content = [item.content];
          let blank = false;
          i++;
          while (i < lines.length) {
            const next = lines[i];
            const nextItem = markerOf(next);
            if (nextItem && nextItem.indent <= first.indent) break;
            if (!next.trim()) { content.push(''); blank = true; i++; continue; }
            const indent = /^ */.exec(next)[0].length;
            if (indent > first.indent) {
              content.push(next.slice(Math.min(indent, item.contentIndent)));
              blank = false; i++; continue;
            }
            // A non-indented line can continue the same list paragraph, but a
            // blank line or a new block ends the item instead of swallowing it.
            if (blank || startsBlock(lines, i)) break;
            content.push(next); i++;
          }
          const body = parseBlocks(content, depth + 1).replace(/^<p>([\s\S]*?)<\/p>/, '$1');
          const number = item.kind === 'ol' && item.number !== expected ? ` value="${item.number}"` : '';
          items.push(`<li${number}>${body}</li>`);
          expected = item.number + 1;
          while (i < lines.length && !lines[i].trim()) i++;
        }
        const start = first.kind === 'ol' && first.number !== 1 ? ` start="${first.number}"` : '';
        out.push(`<${first.kind}${start}>${items.join('\n')}</${first.kind}>`);
        continue;
      }
      const content = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) content.push(lines[i++]);
      out.push(paragraph(content));
    }
    return out.join('\n');
  };
  return parseBlocks(text.replace(/^\t+/gm, (tabs) => '    '.repeat(tabs.length)).split('\n'));
}

/**
 * 安全批量插入子节点。
 * 注意：原生 Element.append(null) 会把 null 转成字符串 "null" 插进 DOM，
 * 条件渲染的按钮很容易踩这个坑，所以统一走这里。
 */
export function appendAll(parent, ...children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}
