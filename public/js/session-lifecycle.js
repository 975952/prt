/** Serialize writes for one conversation while allowing unrelated conversations
 * to save independently. Invalidating an owner prevents queued stale snapshots
 * from recreating a conversation after it was cleared or deleted. */
export function createSessionWriteQueue() {
  const owners = new Map();
  const owner = key => {
    if (!owners.has(key)) owners.set(key, { revision: 0, tail: Promise.resolve() });
    return owners.get(key);
  };
  return {
    revision(key) { return owner(key).revision; },
    invalidate(key) { return ++owner(key).revision; },
    enqueue(key, write, revision = owner(key).revision) {
      const state = owner(key);
      const task = state.tail.catch(() => {}).then(() => revision === state.revision ? write() : null);
      state.tail = task.catch(() => {});
      return task;
    },
    async drain(key) { await owner(key).tail; },
  };
}
