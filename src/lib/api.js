const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');

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
    response = await fetch(`${API_BASE_URL}${path}`, options);
  } catch {
    throw new ApiError('The BillSetu backend is unavailable.', 0);
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
    response = await fetch(`${API_BASE_URL}${path}`, { method: 'GET' });
  } catch {
    throw new ApiError('The BillSetu backend is unavailable.', 0);
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
    });
  } catch {
    throw new ApiError('The BillSetu backend is unavailable.', 0);
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
