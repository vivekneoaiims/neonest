// Storage shim: uses window.storage if available (Claude artifacts),
// falls back to localStorage for standalone PWA
const storage = {
  async get(key) {
    if (window.storage?.get) {
      return window.storage.get(key);
    }
    try {
      const val = localStorage.getItem('nn_' + key);
      if (val === null) throw new Error('not found');
      return { key, value: val, shared: false };
    } catch {
      throw new Error('Key not found');
    }
  },
  async set(key, value) {
    if (window.storage?.set) {
      return window.storage.set(key, value);
    }
    try {
      localStorage.setItem('nn_' + key, value);
      return { key, value, shared: false };
    } catch {
      return null;
    }
  },
  async delete(key) {
    if (window.storage?.delete) {
      return window.storage.delete(key);
    }
    localStorage.removeItem('nn_' + key);
    return { key, deleted: true, shared: false };
  },
  async list(prefix) {
    if (window.storage?.list) {
      return window.storage.list(prefix);
    }
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('nn_')) {
        const realKey = k.slice(4);
        if (!prefix || realKey.startsWith(prefix)) keys.push(realKey);
      }
    }
    return { keys, prefix, shared: false };
  }
};

export default storage;
