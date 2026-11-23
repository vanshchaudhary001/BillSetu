const DATABASE = 'billsetu-local';
const VERSION = 1;
const FILE_STORE = 'documents';

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
    const parsed = JSON.parse(localStorage.getItem(`billsetu:${key}`));
    return parsed ?? fallback;
  } catch { return fallback; }
}

export function writeLocalState(key, value) {
  try { localStorage.setItem(`billsetu:${key}`, JSON.stringify(value)); }
  catch (error) { console.error('BillSetu could not save local workspace state.', error); }
}

export function clearLocalWorkspace() {
  localStorage.removeItem('billsetu:invoices');
  localStorage.removeItem('billsetu:profile');
  localStorage.removeItem('billsetu:preferences');
}
