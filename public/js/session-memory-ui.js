import { iconEl } from './icons.js';
import { t as tr } from './i18n.js';
import { nowISO } from './profile.js';

class SessionMemoryPanel {
  constructor(sessionMemory, { profileStore = null } = {}) {
    this.sessionMemory = sessionMemory;
    this.profileStore = profileStore;
    this.currentSid = null;
    this.docId = '';
    this.panelEl = null;
    this.toggleButtons = [];
    this.saveStates = new Map();
    this.isOpen = false;
    this.searchQuery = '';
    this.editingId = null;
    this.editingSource = 'session';
    this.profileOperations = new Map();
    this.profileWrite = null;
  }

  init(toggleButtons, { retry = () => {}, container = null } = {}) {
    if (this.panelEl) return;
    this.toggleButtons = (Array.isArray(toggleButtons) ? toggleButtons : [toggleButtons]).filter(Boolean);
    this.retry = retry;
    this.container = container;
    this.createPanel();
    this.sessionMemory.onChange(({ sid }) => {
      if (String(sid ?? '') === this.currentSid) this.render();
    });
    this.profileStore?.onChange(() => this.render());
    for (const button of this.toggleButtons) button.addEventListener('click', () => this.toggle());
    this.render();
  }

  createPanel() {
    const panel = document.createElement('section');
    panel.id = 'sessionMemoryPanel';
    panel.className = 'session-memory-panel ' + (this.container ? 'memory-panel-embedded' : 'hidden');
    panel.setAttribute('role', this.container ? 'region' : 'dialog');
    panel.setAttribute('aria-label', this.container ? '已保存的记忆' : '会话记忆');
    if (!this.container) panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
      <header class="memory-panel-header">
        <h2>${this.container ? '已保存的记忆' : '会话记忆'}</h2>
        ${this.container ? '' : '<button type="button" class="memory-close-btn" title="关闭" aria-label="关闭"></button>'}
      </header>
      <div class="memory-panel-search">
        <input type="search" class="memory-search-input" placeholder="搜索记忆" aria-label="搜索记忆">
        <select class="memory-category-filter" aria-label="按分类筛选">
          <option value="">所有分类</option>
          <option value="note">笔记</option>
          <option value="tag">标签</option>
          <option value="reference">引用</option>
          <option value="question">问题</option>
          <option value="identity">身份</option>
          <option value="preference">偏好</option>
          <option value="knowledge">学习</option>
        </select>
      </div>
      <div class="memory-list" aria-live="polite"></div>
      <form class="memory-add-section">
        <p class="memory-context-note" hidden>开始或选择会话后，可添加会话记忆。</p>
        <textarea class="memory-add-input" placeholder="添加一条会话记忆" maxlength="2000" aria-label="记忆内容"></textarea>
        <div class="memory-add-controls">
          <select class="memory-add-category" aria-label="记忆分类">
            <option value="note">笔记</option>
            <option value="tag">标签</option>
            <option value="reference">引用</option>
            <option value="question">问题</option>
          </select>
          <button type="submit" class="memory-add-btn">添加</button>
          <button type="button" class="memory-cancel-btn" hidden>取消</button>
        </div>
        <div class="memory-save-row"><span class="memory-save-status" role="status" aria-live="polite"></span><button type="button" class="memory-retry-btn" hidden>重试保存</button></div>
      </form>
    `;
    // Only localize the static panel template, never user-authored memories.
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, label = node.textContent.trim();
      if (label) node.textContent = node.textContent.replace(label, tr(label));
    }
    for (const node of [panel, ...panel.querySelectorAll('*')]) {
      for (const attribute of ['title', 'aria-label', 'placeholder']) {
        if (node.hasAttribute(attribute)) node.setAttribute(attribute, tr(node.getAttribute(attribute)));
      }
    }
    (this.container || document.body).appendChild(panel);
    this.panelEl = panel;
    panel.querySelector('.memory-close-btn')?.append(iconEl('close', { size: 14 }));

    const form = panel.querySelector('.memory-add-section');
    form.addEventListener('submit', event => {
      event.preventDefault();
      this.submitForm();
    });
    panel.querySelector('.memory-cancel-btn').addEventListener('click', () => this.cancelEdit());
    panel.querySelector('.memory-retry-btn').addEventListener('click', () => {
      const failed = this.profileOperations.get(this.currentSid);
      if (failed?.status === 'error') {
        if (failed.operation.action === 'edit' && this.editingSource === 'profile'
          && this.editingId === failed.operation.id) this.saveEdit();
        else this.writeProfile(failed.operation);
      } else this.retry(this.currentSid);
    });
    panel.querySelector('.memory-close-btn')?.addEventListener('click', () => this.toggle(false));
    panel.querySelector('.memory-add-input').addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        this.submitForm();
      } else if (event.key === 'Escape' && this.editingId) {
        event.preventDefault();
        event.stopPropagation();
        this.cancelEdit();
      }
    });
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !this.container) {
        event.preventDefault(); event.stopPropagation(); this.toggle(false);
      }
    });
    panel.querySelector('.memory-search-input').addEventListener('input', event => {
      this.searchQuery = event.target.value.trim();
      this.render();
    });
    panel.querySelector('.memory-category-filter').addEventListener('change', () => this.render());
  }

  toggle(force) {
    if (this.container) return;
    if (!this.panelEl || (this.currentSid === null && force !== false)) return;
    this.isOpen = typeof force === 'boolean' ? force : !this.isOpen;
    this.panelEl.classList.toggle('hidden', !this.isOpen);
    this.panelEl.setAttribute('aria-hidden', String(!this.isOpen));
    for (const button of this.toggleButtons) button.setAttribute('aria-expanded', String(this.isOpen));
    if (this.isOpen) {
      this.returnFocus = document.activeElement;
      this.panelEl.querySelector('.memory-add-input')?.focus();
      this.profileStore?.load().catch(() => {});
    } else if (this.panelEl.contains(document.activeElement)) {
      this.returnFocus?.focus({ preventScroll: true });
    }
  }

  setSession(sid, { docId = '' } = {}) {
    const nextSid = sid === null || sid === undefined ? null : String(sid);
    if (nextSid !== this.currentSid || docId !== this.docId) {
      this.cancelEdit();
      this.searchQuery = '';
      const search = this.panelEl?.querySelector('.memory-search-input');
      if (search) search.value = '';
      const filter = this.panelEl?.querySelector('.memory-category-filter');
      if (filter) filter.value = '';
    }
    this.currentSid = nextSid;
    this.docId = docId;
    if (nextSid === null) this.toggle(false);
    this.render();
  }

  addMemory() {
    const input = this.panelEl?.querySelector('.memory-add-input');
    const category = this.panelEl?.querySelector('.memory-add-category').value || 'note';
    const content = input?.value.trim() || '';
    if (!content || this.currentSid === null) {
      input?.focus();
      return null;
    }
    const memory = this.sessionMemory.addMemory(this.currentSid, content, category);
    input.value = '';
    return memory;
  }

  editMemory(memId, source = 'session') {
    if (this.profileWrite) return;
    const memory = this.visibleMemories().find(item => item.id === memId && item.origin === source);
    if (!memory) return;
    this.editingId = memId;
    this.editingSource = source;
    this.panelEl.querySelector('.memory-add-input').value = memory.content;
    this.panelEl.querySelector('.memory-add-input').maxLength = source === 'profile' ? 300 : 2000;
    const category = this.panelEl.querySelector('.memory-add-category');
    category.value = source === 'profile' ? 'note' : memory.category;
    category.hidden = source === 'profile';
    this.panelEl.querySelector('.memory-add-btn').textContent = tr('保存');
    this.panelEl.querySelector('.memory-cancel-btn').hidden = false;
    this.renderSaveState();
    this.panelEl.querySelector('.memory-add-input').focus();
  }

  saveEdit(memId = this.editingId) {
    const input = this.panelEl.querySelector('.memory-add-input');
    const content = input.value.trim();
    if (!content || (this.currentSid === null && this.editingSource !== 'profile') || !memId) {
      input.focus();
      return null;
    }
    if (this.editingSource === 'profile') return this.writeProfile({ action: 'edit', id: memId, content });
    const memory = this.sessionMemory.editMemory(this.currentSid, memId, content,
      this.panelEl.querySelector('.memory-add-category').value);
    if (memory) this.cancelEdit();
    return memory;
  }

  submitForm() {
    return this.editingId ? this.saveEdit() : this.addMemory();
  }

  cancelEdit() {
    if (!this.panelEl) return;
    this.editingId = null;
    this.editingSource = 'session';
    this.panelEl.querySelector('.memory-add-input').value = '';
    this.panelEl.querySelector('.memory-add-input').maxLength = 2000;
    this.panelEl.querySelector('.memory-add-category').value = 'note';
    this.panelEl.querySelector('.memory-add-category').hidden = false;
    this.panelEl.querySelector('.memory-add-btn').textContent = tr('添加');
    this.panelEl.querySelector('.memory-cancel-btn').hidden = true;
    this.renderSaveState();
  }

  deleteMemory(memId, source = 'session') {
    if (this.profileWrite || (this.currentSid === null && source !== 'profile')
      || !window.confirm(tr('确定删除这条记忆吗？'))) return false;
    if (source === 'profile') return this.writeProfile({ action: 'remove', id: memId });
    if (this.editingId === memId && this.editingSource === source) this.cancelEdit();
    return this.sessionMemory.removeMemory(this.currentSid, memId);
  }

  /** Project saved records into the panel; never copy profile records into a session. */
  visibleMemories() {
    const session = (this.currentSid === null ? [] : this.sessionMemory.getMemories(this.currentSid))
      .map(memory => ({ ...memory, origin: 'session', scope: 'session' }));
    const profile = (this.profileStore?.data.items || [])
      .filter(item => item.memory?.scope !== 'paper' || (this.docId && item.source?.docId === this.docId))
      .map(item => ({ id: item.id, content: item.level || '', topic: item.topic, boundary: item.boundary || '',
        category: item.memory?.kind || 'knowledge', origin: 'profile', scope: item.memory?.scope || 'global',
        updatedAt: Date.parse(item.updatedAt || item.createdAt) }));
    return [...profile, ...session];
  }

  writeProfile(operation) {
    if (!this.profileStore || this.profileWrite) return this.profileWrite;
    const sid = this.currentSid;
    const docId = this.docId;
    this.profileStore.memoryEditRevision = (this.profileStore.memoryEditRevision || 0) + 1;
    this.profileOperations.set(sid, { status: 'saving', operation });
    this.profileWrite = this.profileStore.update(current => {
      const item = current.items.find(item => item.id === operation.id);
      if (operation.action === 'remove') return item
        ? { ...current, items: current.items.filter(item => item.id !== operation.id) } : null;
      if (!item) throw new Error(tr('这条记忆已被删除，请重新查看'));
      return { ...current, items: current.items.map(record => record.id === operation.id
        ? { ...record, level: operation.content.slice(0, 300), updatedAt: nowISO() } : record) };
    }).then(() => {
      this.profileOperations.set(sid, { status: 'saved', operation });
      if (this.currentSid === sid && this.docId === docId && this.editingSource === 'profile'
        && this.editingId === operation.id) this.cancelEdit();
      return true;
    }).catch(() => {
      this.profileOperations.set(sid, { status: 'error', operation });
      return false;
    }).finally(() => {
      this.profileWrite = null;
      this.render();
    });
    this.render();
    return this.profileWrite;
  }

  render() {
    if (!this.panelEl) return;
    const memories = this.visibleMemories();
    const count = memories.length;
    for (const button of this.toggleButtons) {
      button.dataset.count = String(count);
      button.setAttribute('aria-expanded', String(this.isOpen));
      const label = count ? tr('会话记忆（{0}）', count) : tr('会话记忆');
      button.setAttribute('aria-label', label);
      button.title = label + ' · Ctrl+Shift+M';
      button.disabled = this.currentSid === null;
    }
    this.renderSaveState();

    const category = this.panelEl.querySelector('.memory-category-filter').value;
    const query = this.searchQuery.toLocaleLowerCase();
    const filtered = memories.filter(memory => (!category || memory.category === category)
      && (!query || memory.content.toLocaleLowerCase().includes(query)
        || (memory.topic || '').toLocaleLowerCase().includes(query)
        || (memory.boundary || '').toLocaleLowerCase().includes(query)
        || memory.category.toLocaleLowerCase().includes(query)
        || this.getCategoryLabel(memory.category).toLocaleLowerCase().includes(query)));
    const list = this.panelEl.querySelector('.memory-list');
    list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'memory-empty';
      empty.textContent = tr(memories.length ? '没有找到符合条件的记忆' : '还没有会话记忆');
      list.append(empty);
      return;
    }

    for (const memory of filtered) list.append(this.createMemoryItem(memory));
  }

  createMemoryItem(memory) {
    const item = document.createElement('article');
    item.className = 'memory-item';
    item.dataset.source = memory.origin;
    item.dataset.memoryId = memory.id;
    const header = document.createElement('div');
    header.className = 'memory-item-header';
    const badge = document.createElement('span');
    badge.className = 'memory-category-badge';
    badge.dataset.category = memory.category;
    badge.textContent = this.getCategoryLabel(memory.category);
    const time = document.createElement('time');
    time.className = 'memory-time';
    if (Number.isFinite(new Date(memory.updatedAt).getTime())) time.dateTime = new Date(memory.updatedAt).toISOString();
    time.textContent = this.formatTime(memory.updatedAt);
    const scope = document.createElement('span');
    scope.className = 'memory-scope';
    scope.textContent = tr(({ global: '全局', paper: '本篇论文', session: '本次会话' })[memory.scope]);
    header.append(badge, scope, time);

    const content = document.createElement('p');
    content.className = 'memory-item-content';
    content.textContent = memory.content;

    const actions = document.createElement('div');
    actions.className = 'memory-item-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'memory-edit-btn';
    edit.title = tr('编辑');
    edit.setAttribute('aria-label', tr('编辑记忆'));
    edit.append(iconEl('pencil', { size: 14 }));
    edit.disabled = !!this.profileWrite;
    edit.addEventListener('click', () => this.editMemory(memory.id, memory.origin));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'memory-delete-btn';
    remove.title = tr('删除');
    remove.setAttribute('aria-label', tr('删除记忆'));
    remove.append(iconEl('trash', { size: 14 }));
    remove.disabled = !!this.profileWrite;
    remove.addEventListener('click', () => this.deleteMemory(memory.id, memory.origin));
    actions.append(edit, remove);
    item.append(header);
    if (memory.origin === 'profile' && memory.topic && !memory.content.startsWith(memory.topic)) {
      const topic = document.createElement('p');
      topic.className = 'memory-item-topic';
      topic.textContent = memory.topic;
      item.append(topic);
    }
    item.append(content);
    if (memory.boundary) {
      const boundary = document.createElement('p');
      boundary.className = 'memory-item-boundary';
      boundary.textContent = memory.boundary;
      item.append(boundary);
    }
    item.append(actions);
    return item;
  }

  getCategoryLabel(category) {
    return tr(({ note: '笔记', tag: '标签', reference: '引用', question: '问题',
      identity: '身份', preference: '偏好', knowledge: '学习' })[category] || category);
  }

  setSaveState(sid, status) {
    this.saveStates.set(sid, status);
    if (sid === this.currentSid) this.renderSaveState();
  }

  renderSaveState() {
    if (!this.panelEl) return;
    const profileStatus = this.profileOperations.get(this.currentSid)?.status || '';
    const sessionStatus = this.saveStates.get(this.currentSid) || '';
    const status = [profileStatus, sessionStatus].includes('error') ? 'error'
      : [profileStatus, sessionStatus].includes('saving') ? 'saving' : profileStatus || sessionStatus;
    const label = this.panelEl.querySelector('.memory-save-status');
    label.dataset.status = status;
    label.textContent = status === 'saving' ? tr('正在保存记忆…')
      : status === 'error' ? tr('记忆尚未保存，请重试') : status === 'saved' ? tr('已保存') : '';
    this.panelEl.querySelector('.memory-retry-btn').hidden = status !== 'error';
    this.panelEl.querySelector('.memory-retry-btn').disabled = !!this.profileWrite;
    const canWriteContent = this.currentSid !== null || (this.editingSource === 'profile' && !!this.editingId);
    this.panelEl.querySelector('.memory-context-note').hidden = canWriteContent;
    this.panelEl.querySelector('.memory-add-input').hidden = !canWriteContent;
    this.panelEl.querySelector('.memory-add-input').disabled = !canWriteContent;
    this.panelEl.querySelector('.memory-add-controls').hidden = !canWriteContent;
    this.panelEl.querySelector('.memory-add-btn').disabled = !!this.profileWrite || !canWriteContent;
    this.panelEl.querySelector('.memory-cancel-btn').disabled = !!this.profileWrite;
    this.panelEl.querySelector('.memory-add-input').readOnly = !!this.profileWrite && this.editingSource === 'profile';
  }

  formatTime(ms) {
    const timestamp = Number(ms);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 60000) return tr('刚刚');
    if (diff < 3600000) return tr('{0} 分钟前', Math.floor(diff / 60000));
    if (diff < 86400000) return tr('{0} 小时前', Math.floor(diff / 3600000));
    if (diff < 604800000) return tr('{0} 天前', Math.floor(diff / 86400000));
    return new Date(timestamp).toLocaleDateString();
  }
}

export { SessionMemoryPanel };
