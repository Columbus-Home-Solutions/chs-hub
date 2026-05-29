/**
 * CHS Capture service worker — Phase 5.
 *
 * Responsibilities:
 *   1. Drive an offline upload queue: when the page enqueues a failed
 *      photo / note POST into IndexedDB, register a background sync
 *      tag so the OS can retry once connectivity returns.
 *   2. On 'sync' fire, drain the queue ourselves (so a closed PWA
 *      still flushes once the OS schedules us).
 *   3. Forward "drain me" pokes from the page (for browsers that do
 *      not implement Background Sync, e.g. iOS Safari).
 *   4. Notify all open clients after a drain so the pending badge can
 *      refresh without polling.
 *
 * Intentionally NOT in this version:
 *   - Precaching the shell. Cloudflare's edge already handles HTML
 *     caching; aggressive SW precaching has historically caused stuck
 *     versions. We can revisit if startup latency on slow networks
 *     becomes a real problem.
 *   - A fetch handler. We let the network handle every request directly
 *     so a buggy SW can't brick the PWA.
 */

importScripts('./queue.js');

const SYNC_TAG = (self.CHSQueue && self.CHSQueue.SYNC_TAG) || 'chs-capture-drain';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Background sync handler. Fires when the OS decides we've got
 * connectivity again. We drain best-effort and let any failures stay
 * in the queue for the next sync attempt.
 */
self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(drainAndNotify('sync'));
});

/**
 * Page → SW message channel. The page posts { type: 'drain' } when it
 * sees an `online` event or when the user lands on the Pending screen.
 * This is also the iOS-Safari fallback path since Safari doesn't ship
 * Background Sync.
 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'drain') {
    event.waitUntil(drainAndNotify('message'));
  }
});

async function drainAndNotify(reason) {
  if (!self.CHSQueue) return;
  let result = { ok: 0, failed: 0 };
  try {
    result = await self.CHSQueue.drain();
  } catch (err) {
    // Drain itself failing (e.g. IDB unavailable) shouldn't break the SW.
    console.warn('[chs-capture sw] drain failed:', err);
  }
  // Tell every /capture/ client to refresh its pending badge / list.
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) {
    try {
      c.postMessage({
        type: 'drain-result',
        reason,
        ok: result.ok,
        failed: result.failed,
      });
    } catch (_) { /* dead client, ignore */ }
  }
}
