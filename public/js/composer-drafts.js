/** Current-window composer drafts. No persistence, DOM or model dependencies. */

function ownerKey(owner) {
  // JSON keeps document IDs containing separators distinct. Empty ID is the no-document composer.
  return JSON.stringify([String(owner?.docId ?? ''), owner?.mode === 'translate' ? 'translate' : 'chat']);
}

function copyAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments.filter((a) => a && typeof a === 'object' && !Array.isArray(a)).map((a) => ({ ...a }))
    : [];
}

function snapshot(draft) {
  // Attachment records are flat. Copy the record and array, leaving immutable dataUrl strings alone.
  return { text: String(draft?.text ?? ''), attachments: copyAttachments(draft?.attachments) };
}

/**
 * owner: { docId, mode: 'chat' | 'translate' }. Missing mode defaults to chat.
 * read/write/clear/restoreAttachments return detached { text, attachments } snapshots.
 */
export function createComposerDraftStore() {
  const drafts = new Map();

  function read(owner) {
    return snapshot(drafts.get(ownerKey(owner)));
  }

  function write(owner, draft) {
    const key = ownerKey(owner);
    const saved = snapshot(draft);
    if (saved.text || saved.attachments.length) drafts.set(key, saved);
    else drafts.delete(key);
    return snapshot(saved);
  }

  function clear(owner) {
    drafts.delete(ownerKey(owner));
    return snapshot();
  }

  /**
   * A failed send may finish after the user has typed another draft or switched owners.
   * Keep that owner's current text and current version of each attachment. Restore only
   * missing IDs, before newly added attachments, without duplicating repeated recoveries.
   * Sent attachments without an ID cannot be reconciled safely and are ignored.
   */
  function restoreAttachments(owner, attachments) {
    const current = read(owner);
    const seen = new Set();
    const kept = current.attachments.filter((a) => {
      if (!a.id) return true;
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
    const recovered = copyAttachments(attachments).filter((a) => {
      if (!a.id || seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
    return write(owner, { text: current.text, attachments: [...recovered, ...kept] });
  }

  return { read, write, clear, restoreAttachments };
}
