/** AI proposals only: no configuration access, file reads, or file mutations.
 * The caller supplies the app's chat client and reviews accepted proposals. */
import { t as tr } from './i18n.js';
import { runWithDeadline } from './task-deadline.js';
import { paperClassificationMessages } from './prompts/capabilities/organizer.js';

export const PAPER_CLASSIFIER_BATCH_SIZE = 12;
export const PAPER_CLASSIFIER_MIN_CONFIDENCE = 0.75;
const fail = (code, message) => Object.assign(new Error(message), { name: 'PaperClassificationError', code });
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

/** A relative folder only: no traversal, absolute paths or Windows devices. */
export function validateTargetFolder(value) {
  const raw = String(value ?? ''), folder = raw.replace(/\\/g, '/');
  if (!folder.trim()) return { valid: false, folder: '', error: tr('请选择目标文件夹') };
  if (folder.length > 1000 || /^[\s/]|[\s/]$/.test(folder) || /[<>:"|?*\u0000-\u001f\u007f-\u009f]/.test(folder)) {
    return { valid: false, folder, error: tr('请输入有效的相对文件夹路径') };
  }
  const bad = folder.split('/').some(part => !part || part.startsWith('.') || part.length > 255
    || /[.\s]$/.test(part) || /^\s/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
  return bad ? { valid: false, folder, error: tr('文件夹名称包含无效字符或保留名称') }
    : { valid: true, folder, error: '' };
}

function paperInputs(papers) {
  if (!Array.isArray(papers) || papers.length > PAPER_CLASSIFIER_BATCH_SIZE) {
    throw fail('input', tr('每批最多分类 {0} 篇论文', PAPER_CLASSIFIER_BATCH_SIZE));
  }
  const seen = new Set();
  return papers.map(paper => {
    if (!record(paper) || typeof paper.id !== 'string' || !paper.id.trim()
      || paper.id.length > 1000 || seen.has(paper.id)) throw fail('input', tr('论文分类标识无效或重复'));
    seen.add(paper.id);
    return { id: paper.id, name: text(paper.name, 255), title: text(paper.title, 1000), path: text(paper.path, 1000) };
  });
}

function folderInputs(folders) {
  const out = [], seen = new Set(); let budget = 12000;
  for (const value of Array.isArray(folders) ? folders : []) {
    if (typeof value !== 'string') continue;
    const parsed = validateTargetFolder(value);
    if (!parsed.valid) continue;
    const key = parsed.folder.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (budget < parsed.folder.length) continue;
    out.push(parsed.folder); budget -= parsed.folder.length;
    if (out.length >= 200) break;
  }
  return out;
}

/** Validate the whole envelope/identity set before accepting individual rows.
 * Missing or unsafe rows remain explicit, unselected entries in input order. */
export function parsePaperClassifications(output, papers) {
  const inputs = paperInputs(papers), ids = new Set(inputs.map(paper => paper.id));
  if (typeof output !== 'string' || output.length > 100000) throw fail('json', tr('AI 分类结果不是有效 JSON，请重试'));
  let raw = output.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw);
  if (fenced) raw = fenced[1].trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw fail('json', tr('AI 分类结果不是有效 JSON，请重试')); }
  if (!record(parsed) || Object.keys(parsed).some(key => key !== 'items') || !Array.isArray(parsed.items)) {
    throw fail('schema', tr('AI 分类结果结构无效，请重试'));
  }
  const byId = new Map();
  for (const item of parsed.items) {
    if (!record(item) || typeof item.id !== 'string' || !ids.has(item.id) || byId.has(item.id)) {
      throw fail('identity', tr('AI 分类结果包含未知或重复的论文标识，请重试'));
    }
    byId.set(item.id, item);
  }
  return inputs.map(({ id }) => {
    const unknown = reason => ({ id, folder: '', confidence: 0, reason, selected: false });
    const item = byId.get(id);
    if (!item) return unknown(tr('AI 未返回该论文的分类，请重试或手动选择'));
    if (Object.keys(item).some(key => !['id', 'folder', 'confidence', 'reason'].includes(key))
      || typeof item.folder !== 'string' || typeof item.reason !== 'string' || item.reason.length > 2000
      || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1) return unknown(tr('AI 分类字段无效，请重试或手动选择'));
    const reason = item.reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 500);
    if (!item.folder) return unknown(reason || tr('信息不足，请手动选择文件夹'));
    // Model paths must already be safe relative paths; do not repair a supplied
    // Windows/absolute path into something that could be mistaken for consent.
    if (item.folder.includes('\\') || !validateTargetFolder(item.folder).valid) {
      return unknown(tr('AI 建议的文件夹路径无效，请手动选择'));
    }
    return { id, folder: item.folder, confidence: item.confidence,
      reason: reason || tr('根据标题判断'), selected: item.confidence >= PAPER_CLASSIFIER_MIN_CONFIDENCE };
  });
}

/** One bounded request. Callers decide batch order, retries and confirmation. */
export async function classifyPaperBatch({ papers, folders = [], instructions = '', signal, chat, timeoutMs = 60000 } = {}) {
  const inputs = paperInputs(papers);
  if (!inputs.length) return [];
  if (typeof chat !== 'function') throw fail('configuration', tr('AI 分类服务不可用'));
  const messages = paperClassificationMessages({ papers: inputs, folders: folderInputs(folders), instructions: text(instructions, 2000) });
  const duration = Number(timeoutMs);
  const output = await runWithDeadline(requestSignal => chat({ messages, signal: requestSignal,
    temperature: 0.2 }), { signal, timeoutMs: Number.isFinite(duration) && duration > 0 ? duration : 60000 });
  return parsePaperClassifications(output, inputs);
}
