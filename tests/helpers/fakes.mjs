export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function persistence() {
  const values = new Map(), locks = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const lock = async (name, work) => {
    const previous = locks.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    locks.set(name, next);
    try { return await next; } finally { if (locks.get(name) === next) locks.delete(name); }
  };
  return { storage, lock, values };
}
export const offline = async () => { throw { code: "network", message: "Offline fixture" }; };
