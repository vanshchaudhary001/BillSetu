const DATABASE = 'billsetu-local';
const VERSION = 1;
const FILE_STORE = 'documents';

// Browser-local workspace keys are scoped to the signed-in account so one
// person's saved workspace is never shown inside another account's session.
// Server-owned records are additionally scoped to the business they came from
// (see `readBusinessState`), so a business switch cannot reuse them.
const WORKSPACE_KEYS = ['localInvoices', 'profile', 'preferences', 'audit'];
const LEGACY_RECORDS_KEY = 'invoices';
const LEGACY_OWNER_KEY = 'billsetu:workspace-owner';
let workspaceScope = '';

export function setWorkspaceScope(ownerId) {
  workspaceScope = typeof ownerId === 'string' ? ownerId.trim() : '';
}

function scopedKey(key, owner = workspaceScope) {
  return owner ? `billsetu:${owner}:${key}` : `billsetu:${key}`;
}

export function claimUnscopedWorkspace(ownerId) {
  if (!ownerId) return;
  try {
    const owner = localStorage.getItem(LEGACY_OWNER_KEY);
    if (owner && owner !== ownerId) return;
    localStorage.setItem(LEGACY_OWNER_KEY, ownerId);
    [...WORKSPACE_KEYS, LEGACY_RECORDS_KEY].forEach(key => {
      const legacy = localStorage.getItem(`billsetu:${key}`);
      const scoped = scopedKey(key, ownerId);
      if (legacy !== null && localStorage.getItem(scoped) === null) {
        localStorage.setItem(scoped, legacy);
      }
    });
  } catch { /* a browser that blocks storage keeps the empty in-memory workspace */ }
}

/**
 * One-time, non-destructive split of the pre-8B-7 record cache.
 *
 * Before Phase 8B-7 the browser kept local drafts and backend-extracted
 * invoices in one account-scoped list. Server records are now authoritative
 * from `GET /api/invoices`, so they are dropped from the browser copy (the
 * backend still holds them) and only records that were never persisted to the
 * backend are kept, under their own `localInvoices` key.
 */
export function migrateLegacyRecords(ownerId) {
  if (!ownerId) return;
  try {
    const legacyKey = scopedKey(LEGACY_RECORDS_KEY, ownerId);
    const raw = localStorage.getItem(legacyKey);
    if (raw === null) return;
    const previous = JSON.parse(raw);
    const rows = Array.isArray(previous) ? previous : [];
    const localOnly = rows.filter(row => row && typeof row === 'object' && !row.backendInvoiceId);
    const localKey = scopedKey('localInvoices', ownerId);
    if (localOnly.length && localStorage.getItem(localKey) === null) {
      localStorage.setItem(localKey, JSON.stringify(localOnly));
    }
    localStorage.removeItem(legacyKey);
    localStorage.removeItem(`billsetu:${LEGACY_RECORDS_KEY}`);
  } catch {
    // Unreadable cache: leave it in place rather than deleting a user's data.
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FILE_STORE)) request.result.createObjectStore(FILE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveLocalDocument(id, file) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, 'readwrite');
    transaction.objectStore(FILE_STORE).put(file, id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function loadLocalDocument(id) {
  const db = await openDatabase();
  const file = await new Promise((resolve, reject) => {
    const request = db.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return file;
}

export async function deleteLocalDocument(id) {
  if (!id) return;
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, 'readwrite');
    transaction.objectStore(FILE_STORE).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export function readLocalState(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(scopedKey(key)));
    return parsed ?? fallback;
  } catch { return fallback; }
}

export function writeLocalState(key, value) {
  try { localStorage.setItem(scopedKey(key), JSON.stringify(value)); }
  catch (error) { console.error('BillSetu could not save local workspace state.', error); }
}

// --- business-scoped server cache ------------------------------------------
// The browser caches the server's answer so a reload, or a temporary outage,
// still has something to show. That cache belongs to exactly one business: a
// snapshot written while Business A was active is never read while Business B
// is active, so switching cannot display one business's records as another's.

function businessScopedKey(key, business) {
  return scopedKey(`business:${business}:${key}`);
}

export function readBusinessState(key, fallback, business) {
  if (!business) return fallback;
  try {
    const parsed = JSON.parse(localStorage.getItem(businessScopedKey(key, business)));
    return parsed ?? fallback;
  } catch { return fallback; }
}

export function writeBusinessState(key, value, business) {
  if (!business) return;
  try { localStorage.setItem(businessScopedKey(key, business), JSON.stringify(value)); }
  catch (error) { console.error('BillSetu could not save the server record cache.', error); }
}
