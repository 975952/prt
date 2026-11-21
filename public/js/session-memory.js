/**
 * 会话记忆系统：在会话内自动记录重要信息
 * - 可手动添加/编辑/删除
 * - 支持分类（笔记/标签/引用等）
 * - 自动同步到后端
 */

class SessionMemoryManager {
  constructor() {
    this.memories = new Map(); // sid => memories[]
    this.callbacks = new Set();
  }

  /** 生成简单的 UUID-like id */
  generateId() {
    return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** 获取会话的所有记忆 */
  getMemories(sid) {
    return this.memories.get(sid) || [];
  }

  /** 本地加载记忆（从会话数据） */
  loadFromSession(sid, memories) {
    this.import(sid, memories);
  }

  /** 添加记忆 */
  addMemory(sid, content, category = 'note') {
    const now = Date.now();
    const memory = {
      id: this.generateId(),
      content: String(content).slice(0, 2000),
      category: String(category).slice(0, 50),
      createdAt: now,
      updatedAt: now,
    };

    const list = this.memories.get(sid) || [];
    list.push(memory);
    this.memories.set(sid, list);
    this.notifyChange(sid, memory, 'add');
    return memory;
  }

  /** 编辑记忆 */
  editMemory(sid, memId, content, category) {
    const list = this.memories.get(sid) || [];
    const idx = list.findIndex(m => m.id === memId);
    if (idx < 0) return null;

    const now = Date.now();
    const updated = {
      ...list[idx],
      ...(content !== undefined && { content: String(content).slice(0, 2000) }),
      ...(category !== undefined && { category: String(category).slice(0, 50) }),
      updatedAt: now,
    };
    list[idx] = updated;
    this.notifyChange(sid, updated, 'edit');
    return updated;
  }

  /** 删除记忆 */
  removeMemory(sid, memId) {
    const list = this.memories.get(sid) || [];
    const idx = list.findIndex(m => m.id === memId);
    if (idx < 0) return false;

    list.splice(idx, 1);
    this.notifyChange(sid, { id: memId }, 'remove');
    return true;
  }

  /** 清空会话的所有记忆 */
  clearMemories(sid) {
    this.memories.delete(sid);
    this.notifyChange(sid, null, 'clear');
  }

  /** 获取指定分类的记忆 */
  getByCategory(sid, category) {
    return this.getMemories(sid).filter(m => m.category === category);
  }

  /** 搜索记忆内容 */
  search(sid, query) {
    const q = String(query).toLowerCase();
    return this.getMemories(sid).filter(m =>
      m.content.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)
    );
  }

  /** 注册变化回调 */
  onChange(callback) {
    this.callbacks.add(callback);
  }

  /** 移除回调 */
  offChange(callback) {
    this.callbacks.delete(callback);
  }

  /** 通知所有监听者 */
  notifyChange(sid, memory, action) {
    for (const cb of this.callbacks) {
      try { cb({ sid, memory, action }); } catch (e) { console.error(e); }
    }
  }

  /** 导出当前会话的记忆（用于保存） */
  export(sid) {
    const mems = this.getMemories(sid);
    return mems.length ? mems : undefined;
  }

  /** 导入记忆（用于加载） */
  import(sid, memories) {
    const imported = Array.isArray(memories) ? memories : [];
    this.memories.set(String(sid ?? ''), imported.filter(m => m && typeof m === 'object').map(m => ({
      id: String(m.id || ''),
      content: String(m.content || '').slice(0, 2000),
      category: String(m.category || 'note').slice(0, 50),
      createdAt: Number(m.createdAt) || Date.now(),
      updatedAt: Number(m.updatedAt) || Date.now(),
    })).filter(m => m.id));
  }
}

// 导出单例
const sessionMemory = new SessionMemoryManager();

export { SessionMemoryManager, sessionMemory };
