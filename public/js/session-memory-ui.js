import { iconEl } from './icons.js';
import { t as tr } from './i18n.js';

class SessionMemoryPanel {
  constructor(sessionMemory) {
    this.sessionMemory = sessionMemory;
    this.currentSid = null;
    this.panelEl = null;
    this.toggleButtons = [];
    this.saveStates = new Map();
    this.isOpen = false;
    this.searchQuery = '';
    this.editingId = null;
  }

  init(toggleButtons, { retry = () => {} } = {}) {
    if (this.panelEl) return;
    this.toggleButtons = (Array.isArray(toggleButtons) ? toggleButtons : [toggleButtons]).filter(Boolean);
    this.retry = retry;
    this.createPanel();
    this.sessionMemory.onChange(({ sid }) => {
      if (String(sid ?? '') === this.currentSid) this.render();
    });
    for (const button of this.toggleButtons) button.addEventListener('click', () => this.toggle());
  }

  createPanel() {
    const panel = document.createElement('section');
    panel.id = 'sessionMemoryPanel';
    panel.className = 'session-memory-panel hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '会话记忆');
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
      <header class="memory-panel-header">
        <h2>会话记忆</h2>
        <button type="button" class="memory-close-btn" title="关闭" aria-label="关闭"></button>
      </header>
      <div class="memory-panel-search">
        <input type="search" class="memory-search-input" placeholder="搜索记忆" aria-label="搜索记忆">
        <select class="memory-category-filter" aria-label="按分类筛选">
          <option value="">所有分类</option>
          <option value="note">笔记</option>
          <option value="tag">标签</option>
          <option value="reference">引用</option>
          <option value="question">问题</option>
        </select>
      </div>
      <div class="memory-list" aria-live="polite"></div>
      <form class="memory-add-section">
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
    document.body.appendChild(panel);
    this.panelEl = panel;
    panel.querySelector('.memory-close-btn').append(iconEl('close', { size: 14 }));

    const form = panel.querySelector('.memory-add-section');
    form.addEventListener('submit', event => {
      event.preventDefault();
      this.submitForm();
    });
    panel.querySelector('.memory-cancel-btn').addEventListener('click', () => this.cancelEdit());
    panel.querySelector('.memory-retry-btn').addEventListener('click', () => this.retry(this.currentSid));
    panel.querySelector('.memory-close-btn').addEventListener('click', () => this.toggle(false));
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
      if (event.key === 'Escape') {
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
    if (!this.panelEl || (this.currentSid === null && force !== false)) return;
    this.isOpen = typeof force === 'boolean' ? force : !this.isOpen;
    this.panelEl.classList.toggle('hidden', !this.isOpen);
    this.panelEl.setAttribute('aria-hidden', String(!this.isOpen));
    for (const button of this.toggleButtons) button.setAttribute('aria-expanded', String(this.isOpen));
    if (this.isOpen) {
      this.returnFocus = document.activeElement;
      this.panelEl.querySelector('.memory-add-input')?.focus();
    } else if (this.panelEl.contains(document.activeElement)) {
      this.returnFocus?.focus({ preventScroll: true });
    }
  }

  setSession(sid) {
    const nextSid = sid === null || sid === undefined ? null : String(sid);
    if (nextSid !== this.currentSid) {
      this.cancelEdit();
      this.searchQuery = '';
      const search = this.panelEl?.querySelector('.memory-search-input');
      if (search) search.value = '';
      const filter = this.panelEl?.querySelector('.memory-category-filter');
      if (filter) filter.value = '';
    }
    this.currentSid = nextSid;
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

  editMemory(memId) {
    const memory = this.sessionMemory.getMemories(this.currentSid).find(item => item.id === memId);
    if (!memory) return;
    this.editingId = memId;
    this.panelEl.querySelector('.memory-add-input').value = memory.content;
    this.panelEl.querySelector('.memory-add-category').value = memory.category;
    this.panelEl.querySelector('.memory-add-btn').textContent = tr('保存');
    this.panelEl.querySelector('.memory-cancel-btn').hidden = false;
    this.panelEl.querySelector('.memory-add-input').focus();
  }

  saveEdit(memId = this.editingId) {
    const input = this.panelEl.querySelector('.memory-add-input');
    const content = input.value.trim();
    if (!content || this.currentSid === null || !memId) {
      input.focus();
      return null;
    }
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
    this.panelEl.querySelector('.memory-add-input').value = '';
    this.panelEl.querySelector('.memory-add-category').value = 'note';
    this.panelEl.querySelector('.memory-add-btn').textContent = tr('添加');
    this.panelEl.querySelector('.memory-cancel-btn').hidden = true;
  }

  deleteMemory(memId) {
    if (this.currentSid === null || !window.confirm(tr('确定删除这条记忆吗？'))) return false;
    if (this.editingId === memId) this.cancelEdit();
    return this.sessionMemory.removeMemory(this.currentSid, memId);
  }

  render() {
    if (!this.panelEl) return;
    const memories = this.currentSid === null ? [] : this.sessionMemory.getMemories(this.currentSid);
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
    header.append(badge, time);

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
    edit.addEventListener('click', () => this.editMemory(memory.id));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'memory-delete-btn';
    remove.title = tr('删除');
    remove.setAttribute('aria-label', tr('删除记忆'));
    remove.append(iconEl('trash', { size: 14 }));
    remove.addEventListener('click', () => this.deleteMemory(memory.id));
    actions.append(edit, remove);
    item.append(header, content, actions);
    return item;
  }

  getCategoryLabel(category) {
    return tr(({ note: '笔记', tag: '标签', reference: '引用', question: '问题' })[category] || category);
  }

  setSaveState(sid, status) {
    this.saveStates.set(sid, status);
    if (sid === this.currentSid) this.renderSaveState();
  }

  renderSaveState() {
    if (!this.panelEl) return;
    const status = this.saveStates.get(this.currentSid) || '';
    const label = this.panelEl.querySelector('.memory-save-status');
    label.dataset.status = status;
    label.textContent = status === 'saving' ? tr('正在保存记忆…')
      : status === 'error' ? tr('记忆尚未保存，请重试') : status === 'saved' ? tr('已保存') : '';
    this.panelEl.querySelector('.memory-retry-btn').hidden = status !== 'error';
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
