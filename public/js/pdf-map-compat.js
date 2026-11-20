// PDF.js uses Map upsert methods in both the viewer and the worker.
function installMapMethod(name, method) {
  if (typeof Map.prototype[name] === 'function') return;
  Object.defineProperty(Map.prototype, name, {
    value: method, configurable: true, writable: true,
  });
}

installMapMethod('getOrInsert', function getOrInsert(key, value) {
  if (this.has(key)) return this.get(key);
  this.set(key, value);
  return value;
});

installMapMethod('getOrInsertComputed', function getOrInsertComputed(key, compute) {
  if (typeof compute !== 'function') throw new TypeError('Expected a callback');
  if (this.has(key)) return this.get(key);
  const value = compute(key === 0 ? 0 : key);
  this.set(key, value);
  return value;
});
