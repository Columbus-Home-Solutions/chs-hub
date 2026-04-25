/**
 * CHS Capture — shared IndexedDB queue (Phase 5).
 *
 * Loaded both by the page (via <script>) and by the service worker (via
 * importScripts) so the same enqueue / list / drain primitives run in
 * either context. The shape of stored items:
 *
 *   {
 *     id:         string  // uuid
 *     kind:       'photo' | 'note' | 'expense'
 *     created_at: string  // ISO
 *     attempts:   number  // starts at 0, bumped on each retry
 *     last_error: string | null
 *     payload:    object  // see below per-kind
 *   }
 *
 *   payload (photo):   { metadata: object, original: Blob, thumb: Blob, filename: string }
 *   payload (note):    { body: object }   // exactly the JSON we'd send to /api/notes
 *   payload (expense): { metadata: object, receipt: Blob | null, filename: string }
 *
 * Blobs survive structured-clone into IDB, so we can persist the exact
 * bytes the camera produced and replay them later from either context.
 */

(function () {
  'use strict';

  const DB_NAME = 'chs-capture';
  const DB_VERSION = 1;
  const STORE = 'pending_uploads';
  const SYNC_TAG = 'chs-capture-drain';
  const PHOTOS_URL = '/api/photos';
  const NOTES_URL = '/api/notes';
  const EXPENSES_URL = '/api/expenses';

  /** Open (and migrate) the database. */
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('created_at', 'created_at', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb open failed'));
    });
  }

  /** RFC4122-ish UUID; good enough for queue ids. */
  function uuid() {
    if (self.crypto && self.crypto.randomUUID) return self.crypto.randomUUID();
    return 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** Wrap an IDBRequest in a Promise. */
  function req2promise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Add a new item to the queue. */
  async function add(kind, payload) {
    const db = await open();
    const item = {
      id: uuid(),
      kind,
      created_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
      payload,
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return item;
  }

  /** Return every item, oldest-first. */
  async function list() {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const all = await req2promise(tx.objectStore(STORE).getAll());
    db.close();
    all.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return all;
  }

  /** Number of pending items. Cheap helper for the UI badge. */
  async function count() {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const n = await req2promise(tx.objectStore(STORE).count());
    db.close();
    return n;
  }

  /** Remove a single item by id. */
  async function remove(id) {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  /** Patch an item in-place (used to record attempts / last_error). */
  async function update(id, patch) {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      const getReq = os.get(id);
      getReq.onsuccess = () => {
        const cur = getReq.result;
        if (!cur) { resolve(); return; }
        const next = Object.assign({}, cur, patch);
        os.put(next);
      };
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  /**
   * Replay a single queued item against its destination endpoint.
   * Throws on network or non-2xx HTTP failure so callers can decide
   * whether to leave the item in the queue or remove it.
   */
  async function send(item) {
    if (item.kind === 'photo') {
      const p = item.payload;
      const form = new FormData();
      form.append('original', p.original, p.filename || 'capture.jpg');
      form.append('thumb', p.thumb, 'thumb.jpg');
      form.append('metadata', JSON.stringify(p.metadata || {}));
      const res = await fetch(PHOTOS_URL, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!res.ok) throw new Error('photo HTTP ' + res.status);
      return res;
    }
    if (item.kind === 'note') {
      const res = await fetch(NOTES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(item.payload.body || {}),
      });
      if (!res.ok) throw new Error('note HTTP ' + res.status);
      return res;
    }
    if (item.kind === 'expense') {
      const p = item.payload || {};
      const form = new FormData();
      form.append('metadata', JSON.stringify(p.metadata || {}));
      // Receipt is optional; only attach if we captured one.
      if (p.receipt) form.append('receipt', p.receipt, p.filename || 'receipt.jpg');
      const res = await fetch(EXPENSES_URL, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!res.ok) throw new Error('expense HTTP ' + res.status);
      return res;
    }
    throw new Error('Unknown queue item kind: ' + item.kind);
  }

  /**
   * Try to send every queued item once. Returns { ok, failed } counts.
   * Items that succeed are deleted; items that fail get an attempts++
   * and a last_error string and stay in the queue for the next drain.
   *
   * Safe to call from either the page or the service worker.
   */
  async function drain() {
    const items = await list();
    let ok = 0;
    let failed = 0;
    for (const item of items) {
      try {
        await send(item);
        await remove(item.id);
        ok += 1;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        await update(item.id, {
          attempts: (item.attempts || 0) + 1,
          last_error: msg,
        });
        failed += 1;
      }
    }
    return { ok, failed };
  }

  // Expose under a single namespace on whichever global we're loaded into
  // (window for the page, self/ServiceWorkerGlobalScope for the SW).
  const ns = { add, list, count, remove, update, send, drain, SYNC_TAG };
  if (typeof self !== 'undefined') self.CHSQueue = ns;
})();
