// Everything Folio keeps lives in IndexedDB on this device:
//   sessions — one record per document: pages, blocks, corrections, choices
//   files    — the original PDF or photos, by session id
// Small preferences live in localStorage.

const DB_NAME = 'folio';
const DB_VERSION = 1;
let opening = null;

function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return opening;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage was refused'));
  });
}

export const Store = {
  allSessions: () => run('sessions', 'readonly', t => t.objectStore('sessions').getAll()),
  session: id => run('sessions', 'readonly', t => t.objectStore('sessions').get(id)),
  saveSession: s => run('sessions', 'readwrite', t => t.objectStore('sessions').put(s)),
  files: id => run('files', 'readonly', t => t.objectStore('files').get(id)),
  saveFiles: (id, files) => run('files', 'readwrite', t => t.objectStore('files').put(files, id)),
  forget: id => run(['sessions', 'files'], 'readwrite', t => {
    t.objectStore('sessions').delete(id);
    t.objectStore('files').delete(id);
  }),
  /** Ask the browser not to clear our storage under pressure (granted to installed apps). */
  async persist() {
    try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
    return false;
  },
};

// ---------- preferences ----------

const PREF_KEY = 'folio.prefs';
const defaults = {
  appearance: 'system',      // system | paper | ink
  askBeforeReading: true,
  lastOCR: null,
};

export const Prefs = (() => {
  let data = { ...defaults };
  try { Object.assign(data, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch {}
  return {
    get: k => data[k],
    set(k, v) {
      data[k] = v;
      try { localStorage.setItem(PREF_KEY, JSON.stringify(data)); } catch {}
    },
    all: () => ({ ...data }),
    replace(obj) {
      data = { ...defaults, ...obj };
      try { localStorage.setItem(PREF_KEY, JSON.stringify(data)); } catch {}
    },
  };
})();

// ---------- backup ----------

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export async function makeBackup(includeFiles) {
  const sessions = await Store.allSessions();
  const files = {};
  if (includeFiles) {
    for (const s of sessions) {
      const f = await Store.files(s.id);
      if (f) files[s.id] = f.map(x => ({ name: x.name, type: x.type, data: toBase64(x.data) }));
    }
  }
  return {
    app: 'Folio', kind: 'backup', version: 1,
    exported: new Date().toISOString(),
    prefs: Prefs.all(), sessions, files,
  };
}

/** Merge a backup in. Sessions with the same id are replaced by the backup's copy. */
export async function restoreBackup(json) {
  if (!json || json.app !== 'Folio' || !Array.isArray(json.sessions)) throw new Error('This isn’t a Folio backup.');
  let sessions = 0, withFiles = 0;
  for (const s of json.sessions) {
    if (!s?.id || !Array.isArray(s.pages)) continue;
    await Store.saveSession(s);
    sessions++;
    const f = json.files?.[s.id];
    if (f) {
      await Store.saveFiles(s.id, f.map(x => ({ name: x.name, type: x.type, data: fromBase64(x.data) })));
      withFiles++;
    }
  }
  if (json.prefs) Prefs.replace({ ...Prefs.all(), ...json.prefs });
  return { sessions, withFiles };
}
