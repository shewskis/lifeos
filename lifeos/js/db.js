// db.js — tiny IndexedDB wrapper. All app data lives on-device in IndexedDB.
// Stores are declared by modules (see modules/README.md). Each record is a plain
// object with an `id` (string) and usually a `date` ('YYYY-MM-DD') field.

const DB_NAME = 'lifeos';

export function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class DB {
  constructor() {
    this.db = null;
    this.schema = {}; // storeName -> { keyPath, indexes: [names] }
  }

  /** Register stores. Call before open(). schema: { storeName: { keyPath?: 'id', indexes?: ['date', ...] } } */
  register(schema) {
    for (const [name, def] of Object.entries(schema || {})) {
      this.schema[name] = { keyPath: def.keyPath || 'id', indexes: def.indexes || ['date'] };
    }
  }

  async open() {
    // Open at current version, then bump the version if any registered store is missing.
    let db = await this._open();
    const missing = Object.keys(this.schema).filter((s) => !db.objectStoreNames.contains(s));
    const missingIdx = this._missingIndexes(db);
    if (missing.length || missingIdx) {
      const v = db.version + 1;
      db.close();
      db = await this._open(v);
    }
    this.db = db;
    this.db.onversionchange = () => { this.db.close(); location.reload(); };
    return this;
  }

  _missingIndexes(db) {
    for (const [name, def] of Object.entries(this.schema)) {
      if (!db.objectStoreNames.contains(name)) continue;
      const tx = db.transaction(name, 'readonly');
      const st = tx.objectStore(name);
      for (const idx of def.indexes) if (!st.indexNames.contains(idx)) return true;
    }
    return false;
  }

  _open(version) {
    return new Promise((resolve, reject) => {
      const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        for (const [name, def] of Object.entries(this.schema)) {
          let st;
          if (!db.objectStoreNames.contains(name)) st = db.createObjectStore(name, { keyPath: def.keyPath });
          else st = e.target.transaction.objectStore(name);
          for (const idx of def.indexes) if (!st.indexNames.contains(idx)) st.createIndex(idx, idx, { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('IndexedDB open blocked — close other tabs of this app');
    });
  }

  _tx(store, mode = 'readonly') {
    return this.db.transaction(store, mode).objectStore(store);
  }

  _req(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  /** Insert or update. Assigns id + createdAt if missing, sets updatedAt. Returns the saved record. */
  async put(store, obj) {
    const rec = { ...obj };
    if (!rec.id) rec.id = uid();
    if (!rec.createdAt) rec.createdAt = Date.now();
    rec.updatedAt = Date.now();
    await this._req(this._tx(store, 'readwrite').put(rec));
    this._emit(store);
    return rec;
  }

  async putMany(store, objs) {
    const st = this._tx(store, 'readwrite');
    const out = [];
    for (const o of objs) {
      const rec = { ...o };
      if (!rec.id) rec.id = uid();
      if (!rec.createdAt) rec.createdAt = Date.now();
      rec.updatedAt = Date.now();
      st.put(rec); out.push(rec);
    }
    await new Promise((res, rej) => {
      const tx = st.transaction;
      // A bubbled request error reaches tx.onerror before tx.error is set, so read the request's error first.
      const fail = (e) => rej((e && e.target && e.target.error) || tx.error || new Error('IndexedDB write failed'));
      tx.oncomplete = res;
      tx.onerror = fail;
      tx.onabort = fail;
    });
    this._emit(store);
    return out;
  }

  get(store, id) { return this._req(this._tx(store).get(id)); }

  async delete(store, id) {
    await this._req(this._tx(store, 'readwrite').delete(id));
    this._emit(store);
  }

  async clear(store) {
    await this._req(this._tx(store, 'readwrite').clear());
    this._emit(store);
  }

  /** All records, optionally sorted by an index. opts: { index, dir: 'asc'|'desc', limit } */
  async all(store, opts = {}) {
    let rows = await this._req(this._tx(store).getAll());
    if (opts.index) {
      const k = opts.index;
      rows.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0));
    }
    if (opts.dir === 'desc') rows.reverse();
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows;
  }

  /** Records whose `field` (default 'date') is within [from, to] inclusive. Strings compare lexically, so 'YYYY-MM-DD' works. */
  async range(store, from, to, field = 'date') {
    const idx = this._tx(store).index(field);
    const r = from && to ? IDBKeyRange.bound(from, to) : from ? IDBKeyRange.lowerBound(from) : to ? IDBKeyRange.upperBound(to) : null;
    const rows = await this._req(r ? idx.getAll(r) : idx.getAll());
    return rows;
  }

  /** Records where field === value (field must be an index). */
  async where(store, field, value) {
    return this._req(this._tx(store).index(field).getAll(IDBKeyRange.only(value)));
  }

  count(store) { return this._req(this._tx(store).count()); }

  // --- change events: modules re-render when their store changes ---
  _emit(store) { window.dispatchEvent(new CustomEvent('db:change', { detail: { store } })); }
  onChange(store, fn) {
    const h = (e) => { if (!store || e.detail.store === store) fn(e.detail.store); };
    window.addEventListener('db:change', h);
    return () => window.removeEventListener('db:change', h);
  }

  // --- whole-database export/import (blobs are base64-encoded) ---
  async exportAll() {
    const out = { app: 'lifeos', version: 1, exportedAt: new Date().toISOString(), stores: {} };
    for (const name of Object.keys(this.schema)) {
      const rows = await this.all(name);
      out.stores[name] = await Promise.all(rows.map(serializeBlobs));
    }
    return out;
  }

  async importAll(data, { merge = true } = {}) {
    if (!data || data.app !== 'lifeos' || !data.stores) throw new Error('Not a LifeOS backup file');
    for (const [name, rows] of Object.entries(data.stores)) {
      if (!this.schema[name]) continue;
      if (!merge) await this.clear(name);
      const parsed = await Promise.all(rows.map(deserializeBlobs));
      await this.putMany(name, parsed);
    }
  }
}

async function serializeBlobs(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof Blob) out[k] = { __blob: true, type: v.type, data: await blobToBase64(v) };
    else out[k] = v;
  }
  return out;
}
async function deserializeBlobs(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && v.__blob) out[k] = base64ToBlob(v.data, v.type);
    else out[k] = v;
  }
  return out;
}
export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}
export function base64ToBlob(b64, type = 'application/octet-stream') {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

// --- settings: small key/value in localStorage (synchronous, convenient) ---
export const settings = {
  get(key, def = null) {
    try { const v = localStorage.getItem('lifeos:' + key); return v === null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem('lifeos:' + key, JSON.stringify(val)); } catch (e) { console.warn('settings.set failed', e); }
    window.dispatchEvent(new CustomEvent('settings:change', { detail: { key, val } }));
  },
  remove(key) { localStorage.removeItem('lifeos:' + key); },
};
