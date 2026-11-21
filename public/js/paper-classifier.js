/** AI proposals only: no configuration access, file reads, or file mutations.
 * The caller supplies the app's chat client and reviews accepted proposals. */
import { t as tr } from './i18n.js';
import { runWithDeadline } from './task-deadline.js';
import { paperClassificationMessages, paperFolderPlanningMessages, paperTopicSummaryMessages, paperGroupingMessages, paperFirstPageMessages } from './prompts/capabilities/organizer.js';

export const PAPER_CLASSIFIER_BATCH_SIZE = 12;
export const PAPER_CLASSIFIER_MIN_CONFIDENCE = 0.75;
export const PAPER_PLANNER_CHUNK_SIZE = 200;
export const PAPER_PLANNER_MAX_PAPERS = 5000;
const fail = (code, message) => Object.assign(new Error(message), { name: 'PaperClassificationError', code });
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

/** The organizer creates only siblings directly inside the library. */
export function validateCategory(value) {
  const result = validateTargetFolder(value);
  return result.valid && result.folder.includes('/')
    ? { ...result, valid: false, error: tr('分类只用一层文件夹，请勿输入 / 或反斜线。') } : result;
}

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

function paperInputs(papers, limit = PAPER_CLASSIFIER_BATCH_SIZE) {
  if (!Array.isArray(papers) || papers.length > limit) {
    throw fail('input', tr('每批最多分类 {0} 篇论文', limit));
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

function parseJson(output) {
  if (typeof output !== 'string' || output.length > 100000) throw fail('json', tr('AI 分类结果不是有效 JSON，请重试'));
  let raw = output.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw);
  if (fenced) raw = fenced[1].trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw fail('json', tr('AI 分类结果不是有效 JSON，请重试')); }
  return parsed;
}

function folderLimit(paperCount, maxDepth) {
  if (!Number.isInteger(paperCount) || paperCount < 0 || paperCount > PAPER_PLANNER_MAX_PAPERS || maxDepth !== 1) {
    throw fail('plan', tr('分类目录规划参数无效，请重新规划'));
  }
  return Math.min(paperCount, 6);
}

/** All classification batches must use one validated vocabulary and depth. */
function validatedPlan(plan) {
  if (!record(plan) || !Array.isArray(plan.folders)) throw fail('plan', tr('请先生成统一的分类目录'));
  const maxDepth = plan.maxDepth ?? 1, paperCount = plan.paperCount ?? PAPER_PLANNER_MAX_PAPERS;
  const maxFolders = folderLimit(paperCount, maxDepth);
  if (!plan.folders.length && paperCount || plan.folders.length > maxFolders) throw fail('plan', tr('分类目录数量超出规划限制，请重新规划'));
  const seen = new Set(), depths = new Set();
  const folders = plan.folders.map(folder => {
    if (!record(folder) || Object.keys(folder).some(key => !['path', 'description'].includes(key))
      || typeof folder.path !== 'string' || folder.path.includes('\\') || !validateTargetFolder(folder.path).valid
      || folder.description !== undefined && (typeof folder.description !== 'string' || folder.description.length > 500)) {
      throw fail('plan', tr('AI 返回了无效的分类目录，请重新规划'));
    }
    const depth = folder.path.split('/').length, key = folder.path.normalize('NFKC').toLocaleLowerCase();
    if (depth > maxDepth || seen.has(key) || [...seen].some(existing => existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`))) {
      throw fail('plan', tr('分类目录层级不一致或名称重复，请重新规划'));
    }
    seen.add(key); depths.add(depth);
    return { path: folder.path, description: (folder.description || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() };
  });
  if (depths.size > 1) throw fail('plan', tr('分类目录层级不一致或名称重复，请重新规划'));
  return { folders, maxDepth, paperCount };
}

export function parsePaperFolderPlan(output, { paperCount, maxDepth = 1 } = {}) {
  const parsed = parseJson(output);
  if (!record(parsed) || Object.keys(parsed).some(key => key !== 'folders')) throw fail('plan', tr('AI 返回了无效的分类目录，请重新规划'));
  return validatedPlan({ folders: parsed.folders, paperCount, maxDepth });
}

function parseTopicSummary(output, paperCount) {
  const parsed = parseJson(output);
  if (!record(parsed) || Object.keys(parsed).some(key => !['themes', 'unknownCount'].includes(key))
    || !Array.isArray(parsed.themes) || parsed.themes.length > 8 || !Number.isInteger(parsed.unknownCount) || parsed.unknownCount < 0) {
    throw fail('summary', tr('AI 主题摘要无效，请重试'));
  }
  const themes = parsed.themes.map(theme => {
    if (!record(theme) || Object.keys(theme).some(key => !['name', 'description', 'count'].includes(key))
      || typeof theme.name !== 'string' || !theme.name.trim() || theme.name.length > 80
      || typeof theme.description !== 'string' || theme.description.length > 240
      || !Number.isInteger(theme.count) || theme.count < 1) throw fail('summary', tr('AI 主题摘要无效，请重试'));
    return { name: theme.name, description: theme.description, count: theme.count };
  });
  if (themes.reduce((sum, theme) => sum + theme.count, parsed.unknownCount) !== paperCount) {
    throw fail('summary', tr('AI 主题摘要未覆盖全部论文，请重试'));
  }
  return { themes, unknownCount: parsed.unknownCount, paperCount };
}

function requestModel(messages, { chat, signal, timeoutMs = 60000 }) {
  if (typeof chat !== 'function') throw fail('configuration', tr('AI 分类服务不可用'));
  const duration = Number(timeoutMs);
  return runWithDeadline(requestSignal => chat({ messages, signal: requestSignal, temperature: 0.2 }),
    { signal, timeoutMs: Number.isFinite(duration) && duration > 0 ? duration : 60000 });
}

const compact = (value, limit) => value.length <= limit ? value
  : `${value.slice(0, Math.ceil((limit - 1) / 2))}…${value.slice(-Math.floor((limit - 1) / 2))}`;

/** Every paper participates. Large libraries use bounded summaries, not samples.
 * At most 25 sequential summary calls plus one final plan (5,000 papers). */
export async function planPaperFolders({ papers, folders = [], instructions = '', signal, chat,
  timeoutMs = 60000, maxDepth = 1, onProgress = () => {} } = {}) {
  const inputs = paperInputs(papers, PAPER_PLANNER_MAX_PAPERS), paperCount = inputs.length;
  const maxFolders = folderLimit(paperCount, maxDepth);
  if (!paperCount) return { folders: [], maxDepth, paperCount };
  const context = { instructions: text(instructions, 2000), folders: folderInputs(folders), paperCount, maxDepth, maxFolders };
  // Short indices avoid duplicating long file paths in the planning payload.
  // Both ends are retained when metadata exceeds these declared prompt limits.
  const metadata = inputs.map((paper, index) => ({ index: index + 1,
    name: compact(paper.name, 120), title: compact(paper.title, 240), path: compact(paper.path, 160) }));
  const summaryCount = paperCount > PAPER_PLANNER_CHUNK_SIZE ? Math.ceil(paperCount / PAPER_PLANNER_CHUNK_SIZE) : 0;
  const total = summaryCount + 1, summaries = [];
  for (let at = 0; at < paperCount && summaryCount; at += PAPER_PLANNER_CHUNK_SIZE) {
    onProgress({ stage: 'summarize', completed: summaries.length, total });
    const chunk = metadata.slice(at, at + PAPER_PLANNER_CHUNK_SIZE);
    const output = await requestModel(paperTopicSummaryMessages({ instructions: context.instructions, papers: chunk }), { chat, signal, timeoutMs });
    summaries.push(parseTopicSummary(output, chunk.length));
  }
  onProgress({ stage: 'plan', completed: summaries.length, total });
  const output = await requestModel(paperFolderPlanningMessages({ ...context,
    papers: summaryCount ? [] : metadata, summaries }), { chat, signal, timeoutMs });
  const plan = parsePaperFolderPlan(output, { paperCount, maxDepth });
  onProgress({ stage: 'plan', completed: total, total });
  return plan;
}

/** Validate the whole envelope/identity set before accepting individual rows.
 * Missing, unsafe or out-of-plan rows remain unselected in input order. */
export function parsePaperClassifications(output, papers, plan) {
  const inputs = paperInputs(papers), ids = new Set(inputs.map(paper => paper.id));
  const allowed = new Set(validatedPlan(plan).folders.map(folder => folder.path));
  const parsed = parseJson(output);
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
    if (item.keep === true && Object.keys(item).every(key => ['id', 'keep'].includes(key))) {
      return { id, folder: '', confidence: 1, reason: tr('保持原样'), selected: false, keep: true };
    }
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
    if (!allowed.has(item.folder)) return unknown(tr('AI 建议不在统一目录中，请重试或手动选择'));
    return { id, folder: item.folder, confidence: item.confidence,
      reason: reason || tr('根据标题判断'), selected: item.confidence >= PAPER_CLASSIFIER_MIN_CONFIDENCE };
  });
}

/** One bounded request. Callers decide batch order, retries and confirmation. */
export async function classifyPaperBatch({ papers, plan, instructions = '', signal, chat, timeoutMs = 60000 } = {}) {
  const inputs = paperInputs(papers);
  if (!inputs.length) return [];
  const validated = validatedPlan(plan);
  const messages = paperClassificationMessages({ papers: inputs, folders: validated.folders, instructions: text(instructions, 2000) });
  const output = await requestModel(messages, { chat, signal, timeoutMs });
  return parsePaperClassifications(output, inputs, validated);
}

export function parsePaperGroups(output, papers) {
  const parsed = parseJson(output), seen = new Set(), names = new Set();
  if (!record(parsed) || Object.keys(parsed).some(key => !['groups', 'unknown', 'keep'].includes(key))
    || !Array.isArray(parsed.groups) || parsed.groups.length > Math.min(6, papers.length)
    || !Array.isArray(parsed.unknown) || parsed.keep !== undefined && !Array.isArray(parsed.keep)) throw fail('schema', tr('AI 分类结果结构无效，请重试'));
  const take = index => {
    if (!Number.isInteger(index) || index < 1 || index > papers.length || seen.has(index)) {
      throw fail('identity', tr('AI 分类结果包含未知或重复的论文标识，请重试'));
    }
    seen.add(index); return papers[index - 1].id;
  };
  const groups = parsed.groups.map(group => {
    if (!record(group) || Object.keys(group).some(key => !['folder', 'papers'].includes(key))
      || typeof group.folder !== 'string' || !validateCategory(group.folder).valid || group.folder.length > 80
      || !Array.isArray(group.papers) || !group.papers.length) throw fail('plan', tr('AI 返回了无效的分类目录，请重新规划'));
    const key = group.folder.normalize('NFKC').toLocaleLowerCase();
    if (names.has(key)) throw fail('plan', tr('分类目录层级不一致或名称重复，请重新规划'));
    names.add(key); return { folder: group.folder, ids: group.papers.map(take) };
  });
  const unknown = parsed.unknown.map(take);
  const keep = (parsed.keep || []).map(take);
  if (seen.size !== papers.length) throw fail('identity', tr('AI 未覆盖全部文件，请重新分类'));
  return { groups, unknown, keep };
}

/** Name-only first pass; only unresolved papers may access page one. No file mutations. */
export async function groupPaperCollection({ papers, instructions = '', chat, signal, readFirstPage,
  timeoutMs = 180000, onProgress = () => {}, onUpdate = () => {} } = {}) {
  const inputs = paperInputs(papers, PAPER_PLANNER_MAX_PAPERS).map(paper => ({ ...paper, title: '' }));
  const currentFolder = paper => {
    const path = paper.path.replace(/\\/g, '/');
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  };
  const request = messages => requestModel(messages, { chat, signal, timeoutMs });
  const evidence = new Map(), errors = new Map(), textPages = new Map();
  const inspectImage = async (original, page) => {
    if (typeof page.getImage !== 'function') return '';
    onProgress({ stage: 'image', name: original.name });
    const shot = await runWithDeadline(requestSignal => page.getImage({ signal: requestSignal }), { signal, timeoutMs: 30000 });
    if (!shot?.dataUrl) return '';
    const parsed = parseJson(await request(paperFirstPageMessages({ name: original.name, image: shot.dataUrl })));
    if (!record(parsed) || typeof parsed.evidence !== 'string' || Object.keys(parsed).some(key => key !== 'evidence')) {
      throw fail('schema', tr('AI 分类结果结构无效，请重试'));
    }
    return parsed.evidence.trim().slice(0, 1000);
  };
  const group = async () => {
    onProgress({ stage: 'group' });
    if (inputs.length <= PAPER_PLANNER_CHUNK_SIZE) {
      return parsePaperGroups(await request(paperGroupingMessages({ instructions: text(instructions, 2000),
        papers: inputs.map((paper, index) => ({ index: index + 1, name: paper.name, currentFolder: currentFolder(paper),
          ...(evidence.has(paper.id) ? { evidence: evidence.get(paper.id) } : {}) })) })), inputs);
    }
    // Large libraries still use one shared vocabulary covering the entire collection.
    const enriched = inputs.map(paper => ({ ...paper, title: evidence.get(paper.id) || '' }));
    const plan = await planPaperFolders({ papers: enriched, folders: [...new Set(inputs.map(currentFolder).filter(Boolean))], instructions, chat, signal, timeoutMs });
    const groups = plan.folders.map(folder => ({ folder: folder.path, ids: [] })), unknown = [], keep = [];
    for (let at = 0; at < enriched.length; at += PAPER_CLASSIFIER_BATCH_SIZE) {
      const items = await classifyPaperBatch({ papers: enriched.slice(at, at + PAPER_CLASSIFIER_BATCH_SIZE), plan,
        instructions, chat, signal, timeoutMs });
      for (const item of items) {
        if (item.keep) keep.push(item.id);
        else if (item.selected) groups.find(group => group.folder === item.folder).ids.push(item.id);
        else unknown.push(item.id);
      }
    }
    return { groups: groups.filter(group => group.ids.length), unknown, keep };
  };
  if (!inputs.length) return { groups: [], unknown: [], errors };
  let result = await group(); onUpdate(result);
  const readAttempted = new Set(), imageAttempted = new Set();
  while (readFirstPage) {
    const unresolved = result.unknown.filter(id => !readAttempted.has(id));
    if (unresolved.length) {
      let addedEvidence = 0;
      for (let index = 0; index < unresolved.length; index++) {
        if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
        const id = unresolved[index], original = papers.find(paper => paper.id === id);
        readAttempted.add(id);
        onProgress({ stage: 'page', name: original.name, completed: index, total: unresolved.length });
        try {
          const page = await runWithDeadline(requestSignal => readFirstPage(original, { signal: requestSignal }), { signal, timeoutMs: 30000 });
          let detail = '';
          // Feed extracted text directly into the shared grouping request. Do not
          // spend one extra model round-trip per ordinary text PDF.
          if (String(page.text || '').replace(/\s/g, '').length >= 20) {
            detail = text(page.text, 4000); textPages.set(id, page);
          } else {
            imageAttempted.add(id);
            detail = await inspectImage(original, page);
          }
          if (detail) { evidence.set(id, detail); addedEvidence++; }
          else errors.set(id, tr('第一页仍无法判断，请手动分类'));
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError') throw error;
          errors.set(id, tr('第一页读取失败：{0}', error.message || String(error)));
        }
      }
      if (addedEvidence) { result = await group(); onUpdate(result); continue; }
    }
    // A text layer can be present but garbled or merely a publisher's imprint.
    // Only pages still unknown after the shared text pass need their image.
    const needImage = result.unknown.filter(id => textPages.has(id) && !imageAttempted.has(id));
    if (needImage.length) {
      let imageUpdates = 0;
      for (const id of needImage) {
        if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
        const original = papers.find(paper => paper.id === id);
        imageAttempted.add(id);
        try {
          const detail = await inspectImage(original, textPages.get(id));
          if (detail) { evidence.set(id, detail); imageUpdates++; }
          else errors.set(id, tr('第一页仍无法判断，请手动分类'));
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError') throw error;
          errors.set(id, tr('第一页读取失败：{0}', error.message || String(error)));
        }
      }
      if (imageUpdates) { result = await group(); onUpdate(result); continue; }
    }
    break;
  }
  for (const id of result.unknown) {
    if (readAttempted.has(id) && !errors.has(id)) {
      errors.set(id, tr('已读第一页，仍无法判断，请手动分类'));
    }
  }
  return { ...result, errors };
}
