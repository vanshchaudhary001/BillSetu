const API_BASE_URL = (import.meta.env?.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, status = 0, detail = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    // The backend session lives in an HttpOnly cookie, so every call must be credentialed.
    response = await fetch(`${API_BASE_URL}${path}`, { credentials: 'include', ...options });
  } catch {
    throw new ApiError('The Bill Setu backend is unavailable.', 0);
  }

  const payload = await readResponse(response);
  if (!response.ok) {
    const isInvoiceValidation = path.startsWith('/api/invoices/') && path.endsWith('/validate');
    const isInvoiceGstr1 = path.startsWith('/api/invoices/') && path.endsWith('/gstr1');
    const detail = typeof payload === 'object' && payload?.detail
      ? payload.detail
      : typeof payload === 'string'
        ? payload
        : '';
    const messages = {
      400: 'The backend could not process this document request.',
      401: 'Your Bill Setu session is not active. Sign in again to continue.',
      403: 'This Bill Setu session cannot use a business context right now.',
      404: isInvoiceValidation
        ? 'The extracted invoice could not be found for backend validation.'
        : isInvoiceGstr1
          ? 'The extracted invoice could not be found for backend GSTR-1.'
          : 'The uploaded document could not be found by the backend.',
      409: 'This document requires review and was quarantined by the backend.',
      422: isInvoiceValidation
        ? 'The backend rejected the validation request.'
        : isInvoiceGstr1
          ? 'The backend could not produce a GSTR-1 record for this invoice.'
          : 'The backend rejected this document.',
      503: isInvoiceValidation
        ? 'The backend validation service is unavailable.'
        : isInvoiceGstr1
          ? 'The backend GSTR-1 service is unavailable.'
          : 'The backend extraction service is unavailable.',
    };
    throw new ApiError(messages[response.status] || `The backend request failed (${response.status}).`, response.status, detail);
  }
  return payload;
}

function filenameFromContentDisposition(header) {
  if (!header) return '';
  const encoded = header.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1]?.trim().replace(/^"|"$/g, '');
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return header.match(/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i)?.slice(1).find(Boolean)?.trim() || '';
}

async function requestExport(path) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { method: 'GET', credentials: 'include' });
  } catch {
    throw new ApiError('The Bill Setu backend is unavailable.', 0);
  }

  if (!response.ok) {
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const detail = typeof payload?.detail === 'string' ? payload.detail : text;
    const messages = {
      404: 'The backend invoice could not be found for export.',
      409: 'The backend marked this invoice as not export-ready.',
      422: 'The backend could not generate this export.',
      503: 'The backend export service is unavailable.',
    };
    throw new ApiError(messages[response.status] || `The backend export request failed (${response.status}).`, response.status, detail);
  }

  const blob = await response.blob();
  if (!blob.size) {
    throw new ApiError('The backend returned an empty export.', 502);
  }
  return {
    blob,
    filename: filenameFromContentDisposition(response.headers.get('content-disposition')),
  };
}

export async function healthCheck() {
  return request('/health', { method: 'GET' });
}

function authErrorMessage(path, status) {
  if (status === 0) return 'The Bill Setu backend is unavailable. Check your connection and try again.';
  if (status === 401) {
    return path.endsWith('/login')
      ? 'Invalid email or password.'
      : 'Your session has expired. Please sign in again.';
  }
  if (status === 409) return 'An account with this email already exists. Sign in instead.';
  if (status === 422) return 'Check the email address and password, then try again.';
  if (status === 429) return 'Too many attempts. Wait a moment and try again.';
  return 'The Bill Setu server could not complete this request. Try again in a moment.';
}

function normalizeAuthUser(payload) {
  if (!payload
    || typeof payload !== 'object'
    || typeof payload.id !== 'string'
    || !payload.id
    || typeof payload.email !== 'string'
    || !payload.email) {
    throw new ApiError('The Bill Setu backend returned an unexpected response.', 502);
  }
  return { id: payload.id, email: payload.email, isActive: payload.is_active !== false };
}

async function authRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new ApiError(authErrorMessage(path, 0), 0);
  }

  const payload = await readResponse(response);
  if (!response.ok) {
    const detail = typeof payload === 'object' && payload && typeof payload.detail === 'string'
      ? payload.detail
      : '';
    throw new ApiError(authErrorMessage(path, response.status), response.status, detail);
  }
  return payload;
}

export async function register(email, password) {
  const payload = await authRequest('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return normalizeAuthUser(payload);
}

export async function login(email, password) {
  const payload = await authRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return normalizeAuthUser(payload);
}

export async function getCurrentUser() {
  return normalizeAuthUser(await authRequest('/api/auth/me', { method: 'GET' }));
}

function normalizeBusiness(payload) {
  if (!payload
    || typeof payload !== 'object'
    || typeof payload.id !== 'string'
    || !payload.id
    || typeof payload.name !== 'string'
    || !payload.name) {
    throw new ApiError('The Bill Setu backend returned an unexpected business response.', 502);
  }
  return {
    id: payload.id,
    name: payload.name,
    isActive: payload.is_active !== false,
  };
}

export async function getCurrentBusiness() {
  return normalizeBusiness(await authRequest('/api/businesses/current', { method: 'GET' }));
}

export async function listBusinesses() {
  const payload = await authRequest('/api/businesses', { method: 'GET' });
  if (!Array.isArray(payload)) throw new ApiError('The Bill Setu backend returned an unexpected response.', 502);
  return payload.map(normalizeBusiness);
}

export async function switchBusiness(businessId) {
  if (!businessId) throw new ApiError('Choose a business before switching.', 422);
  return normalizeBusiness(await authRequest(`/api/businesses/${encodeURIComponent(businessId)}/switch`, {
    method: 'POST',
  }));
}

export async function logout() {
  await authRequest('/api/auth/logout', { method: 'POST' });
}

const MALFORMED_LIST = 'The Bill Setu backend returned an unexpected record list.';

function recordList(payload) {
  if (!Array.isArray(payload)) throw new ApiError(MALFORMED_LIST, 502);
  return payload;
}

/**
 * Business-scoped invoice list. The backend derives the business from the
 * session cookie, so the browser never sends an owner. Each row is an invoice
 * summary (header fields only, no line items).
 */
export async function listInvoices() {
  const payload = recordList(await request('/api/invoices', { method: 'GET' }));
  payload.forEach(row => {
    if (!row || typeof row !== 'object' || typeof row.invoice_id !== 'string' || !row.invoice_id.trim()) {
      throw new ApiError(MALFORMED_LIST, 502);
    }
  });
  return payload;
}

/**
 * Business-scoped document metadata. Document contents are never fetched here;
 * the protected content endpoint stays an on-demand call per preview.
 */
export async function listDocuments() {
  const payload = recordList(await request('/api/documents', { method: 'GET' }));
  payload.forEach(row => {
    if (!row || typeof row !== 'object' || typeof row.document_id !== 'string' || !row.document_id.trim()) {
      throw new ApiError(MALFORMED_LIST, 502);
    }
  });
  return payload;
}

export async function uploadDocument(file) {
  const form = new FormData();
  form.append('file', file);
  return request('/api/documents/upload', {
    method: 'POST',
    body: form,
  });
}

export async function extractDocument(documentId) {
  if (!documentId) throw new ApiError('The backend did not return a document ID.', 422);
  return request(`/api/documents/${encodeURIComponent(documentId)}/extract`, {
    method: 'POST',
  });
}

export async function getDocumentContent(documentId) {
  if (!documentId) throw new ApiError('The backend did not return a document ID for source preview.', 422);
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/api/documents/${encodeURIComponent(documentId)}/content`, {
      method: 'GET',
      credentials: 'include',
    });
  } catch {
    throw new ApiError('The Bill Setu backend is unavailable.', 0);
  }

  if (!response.ok) {
    const payload = await readResponse(response);
    const detail = typeof payload === 'object' && payload?.detail
      ? payload.detail
      : typeof payload === 'string'
        ? payload
        : '';
    throw new ApiError(
      response.status === 404
        ? 'The original uploaded document could not be found.'
        : `The backend source preview request failed (${response.status}).`,
      response.status,
      detail,
    );
  }

  const blob = await response.blob();
  if (!blob.size) throw new ApiError('The backend returned an empty source document.', 502);
  return blob;
}

export async function validateInvoice(invoiceId) {
  if (!invoiceId) throw new ApiError('The backend did not return an invoice ID for validation.', 422);
  return request(`/api/invoices/${encodeURIComponent(invoiceId)}/validate`, {
    method: 'POST',
  });
}

export async function getInvoiceGstr1(invoiceId) {
  if (!invoiceId) throw new ApiError('The backend did not return an invoice ID for GSTR-1.', 422);
  return request(`/api/invoices/${encodeURIComponent(invoiceId)}/gstr1`, {
    method: 'GET',
  });
}

export async function getDocumentAudit(documentId) {
  if (!documentId) throw new ApiError('The backend did not return a document ID for audit history.', 422);
  return request(`/api/documents/${encodeURIComponent(documentId)}/audit`, {
    method: 'GET',
  });
}

export async function getInvoiceAudit(invoiceId) {
  if (!invoiceId) throw new ApiError('The backend did not return an invoice ID for audit history.', 422);
  return request(`/api/invoices/${encodeURIComponent(invoiceId)}/audit`, {
    method: 'GET',
  });
}

export async function exportInvoiceJson(invoiceId) {
  if (!invoiceId) throw new ApiError('The backend did not return an invoice ID for JSON export.', 422);
  return requestExport(`/api/invoices/${encodeURIComponent(invoiceId)}/export/json`);
}

export async function exportInvoiceCsv(invoiceId) {
  if (!invoiceId) throw new ApiError('The backend did not return an invoice ID for CSV export.', 422);
  return requestExport(`/api/invoices/${encodeURIComponent(invoiceId)}/export/csv`);
}
