import { normalizeDate } from './intake.js';
import { STATE_CODES } from './gst.js';

// Shown when the list endpoint's invoice has no validation result attached yet.
// A record can only be confirmed once the backend has validated it.
export const SERVER_VALIDATION_PENDING = 'No backend validation result has been loaded for this invoice yet. Open the record to request one from BillSetu.';

const numberValue = value => {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const validationStatuses = {
  validated: 'ready',
  review_required: 'review',
  blocked: 'blocked',
};

export function mapBackendValidationToFrontendInvoice(invoice, validation, validationError = '') {
  if (validation) {
    const validStatus = Object.hasOwn(validationStatuses, validation.status);
    const validIssues = Array.isArray(validation.issues)
      && validation.issues.every(issue => issue
        && typeof issue.rule_id === 'string'
        && ['advisory', 'warning', 'error', 'critical'].includes(issue.severity)
        && typeof issue.message_en === 'string');
    if (!validStatus
      || !validIssues
      || !Array.isArray(validation.confidence)
      || typeof validation.fingerprint !== 'string'
      || typeof validation.export_ready !== 'boolean'
      || !validation.summary
      || typeof validation.summary !== 'object'
      || typeof validation.summary.headline !== 'string'
      || typeof validation.summary.message !== 'string') {
      throw new Error('The backend returned an unexpected validation response.');
    }
  }

  const ruleOccurrences = new Map();
  const findings = validation
    ? validation.issues.map(issue => {
      const occurrence = ruleOccurrences.get(issue.rule_id) || 0;
      ruleOccurrences.set(issue.rule_id, occurrence + 1);
      return {
        id: occurrence ? `${issue.rule_id}-${occurrence}` : issue.rule_id,
        ruleId: issue.rule_id,
        label: issue.rule_id,
        severity: ['error', 'critical'].includes(issue.severity) ? 'error' : 'warning',
        message: issue.message_en,
        field: issue.field_path || '',
        suggestedFix: issue.suggested_value || '',
        authority: 'backend',
      };
    })
    : validationError
      ? [{
        id: 'BACKEND_VALIDATION',
        label: 'Backend validation unavailable',
        severity: 'error',
        message: validationError,
        field: 'validation',
        suggestedFix: '',
        authority: 'backend',
      }]
      : [];
  const backendBucket = validation?.gstr1_bucket;

  return {
    ...invoice,
    validationAuthority: 'backend',
    backendValidation: validation || null,
    backendValidationStatus: validation?.status || null,
    backendValidationError: validation ? '' : validationError,
    backendValidationStale: Boolean(invoice.backendValidationStale),
    backendConfidence: validation?.confidence || [],
    backendGstr1: invoice.backendGstr1 || null,
    backendGstr1Status: invoice.backendGstr1
      ? 'available'
      : validation
        ? invoice.backendGstr1Status || 'pending'
        : invoice.backendGstr1Status || '',
    backendGstr1Error: invoice.backendGstr1 ? '' : invoice.backendGstr1Error || '',
    findings,
    status: invoice.direction === 'purchase'
      ? 'purchase'
      : invoice.backendQuarantined
        ? 'blocked'
        : validation
          ? validationStatuses[validation.status]
          : 'review',
    bucket: backendBucket ? backendBucket.toUpperCase() : invoice.direction === 'purchase' ? 'Purchase' : 'Review',
    issues: validation
      ? findings.map(finding => finding.label)
      : validationError
        ? [`Backend validation unavailable: ${validationError}`]
        : [],
  };
}

export function mapBackendGstr1ToFrontendInvoice(invoice, gstr1Record) {
  const amountFields = ['taxable_value', 'cgst_total', 'sgst_total', 'igst_total', 'cess_total', 'grand_total'];
  const validRecord = gstr1Record
    && typeof gstr1Record === 'object'
    && typeof gstr1Record.invoice_number === 'string'
    && typeof gstr1Record.invoice_date === 'string'
    && ['B2B', 'B2CL', 'B2CS'].includes(gstr1Record.invoice_type)
    && amountFields.every(field => Number.isFinite(Number(gstr1Record[field])))
    && Array.isArray(gstr1Record.line_items)
    && gstr1Record.line_items.every(item => item && typeof item === 'object');
  if (!validRecord) {
    throw new Error('The backend returned an unexpected GSTR-1 response.');
  }

  return {
    ...invoice,
    backendGstr1: gstr1Record,
    backendGstr1Status: 'available',
    backendGstr1Error: '',
  };
}

export function markBackendGstr1Unavailable(invoice, error) {
  return {
    ...invoice,
    backendGstr1: invoice.backendGstr1 || null,
    backendGstr1Status: invoice.backendGstr1 ? 'available' : 'unavailable',
    backendGstr1Error: invoice.backendGstr1 ? '' : error,
  };
}

export function mapCanonicalInvoiceToFrontendInvoice(canonicalInvoice, metadata = {}) {
  if (!canonicalInvoice || typeof canonicalInvoice !== 'object') {
    throw new Error('The backend returned an unexpected extraction response.');
  }

  const invoice = canonicalInvoice;
  const totals = invoice.totals || {};
  const buyer = invoice.buyer || {};
  const supplier = invoice.supplier || {};
  const isoDate = normalizeDate(invoice.invoice_date || '') || '';
  const taxable = numberValue(totals.taxable_value);
  const cgst = numberValue(totals.cgst_total);
  const sgst = numberValue(totals.sgst_total);
  const igst = numberValue(totals.igst_total);
  const cess = numberValue(totals.cess_total);
  const tax = cgst + sgst + igst + cess;
  const grandTotal = numberValue(totals.grand_total);
  const direction = invoice.transaction_direction === 'inward_purchase' ? 'purchase' : 'sale';
  const quarantine = invoice.suspicious_instruction_text_detected || invoice.document_type === 'unreadable';
  const sharpness = invoice.image_sharpness;
  const confidence = sharpness === null || sharpness === undefined
    ? 82
    : Math.round(Math.max(0, Math.min(1, numberValue(sharpness))) * 100);
  const items = Array.isArray(invoice.line_items)
    ? invoice.line_items.map(item => ({
      description: item.description || '',
      quantity: numberValue(item.quantity),
      rate: numberValue(item.unit_rate),
      discount: numberValue(item.discount),
      hsn: item.hsn_sac || '',
    }))
    : [];

  // The CanonicalInvoice has no frontend party-address or review-confidence
  // equivalent; address is set by App.jsx profile context and existing defaults
  // are used for missing extracted values.
  const frontendInvoice = {
    id: metadata.invoiceId || metadata.documentId || `api-${crypto.randomUUID()}`,
    no: String(invoice.invoice_number || '').trim() || 'Invoice to identify',
    party: String(buyer.name || '').trim() || 'Buyer to confirm',
    gstin: String(buyer.gstin || '').trim() || 'Unregistered',
    date: isoDate,
    isoDate,
    amount: taxable,
    tax,
    cgst,
    sgst,
    igst,
    cess,
    taxHeadsCaptured: [cgst, sgst, igst, cess].some(value => value > 0),
    totalWritten: grandTotal || taxable + tax,
    bucket: 'Review',
    status: quarantine ? 'blocked' : 'review',
    issues: quarantine
      ? ['Backend quarantined this document for manual review']
      : ['Backend extraction — compare each field with the original document'],
    source: metadata.fileName || 'Backend extraction',
    confidence,
    color: 'mint',
    kind: invoice.document_type === 'credit_note' ? 'Credit note' : 'Tax invoice',
    supplier: String(supplier.name || '').trim(),
    supplierGstin: String(supplier.gstin || '').trim(),
    supplierStateCode: String(supplier.state_code || '').trim(),
    buyerAddress: '',
    pos: '',
    posStateCode: String(invoice.place_of_supply_state_code || '').trim(),
    hsn: String(items[0]?.hsn || ''),
    direction,
    rawText: '',
    items,
    backendDocumentId: metadata.documentId || '',
    backendInvoiceId: metadata.invoiceId || '',
    businessId: metadata.businessId || '',
    extractionSource: 'backend',
  };

  return mapBackendValidationToFrontendInvoice(
    frontendInvoice,
    metadata.validation || null,
    metadata.validationError || '',
  );
}

/**
 * One invoice as returned by the business-scoped list endpoint.
 *
 * The list carries invoice-header facts only, so nothing here downloads line
 * items or document contents. Validation is requested later, on demand, when
 * the record is opened.
 */
export function mapServerInvoiceSummaryToFrontendInvoice(summary, metadata = {}) {
  if (!summary || typeof summary !== 'object' || typeof summary.invoice_id !== 'string') {
    throw new Error('The backend returned an unexpected invoice list row.');
  }

  const isoDate = normalizeDate(summary.invoice_date || '') || '';
  const taxable = numberValue(summary.taxable_value);
  const cgst = numberValue(summary.cgst_total);
  const sgst = numberValue(summary.sgst_total);
  const igst = numberValue(summary.igst_total);
  const cess = numberValue(summary.cess_total);
  const tax = cgst + sgst + igst + cess;
  const grandTotal = numberValue(summary.grand_total);
  const direction = summary.transaction_direction === 'inward_purchase' ? 'purchase' : 'sale';
  const posStateCode = String(summary.place_of_supply_state_code || '').trim();
  const document = metadata.document || null;

  const frontendInvoice = {
    // The backend invoice id is the authoritative identity for a persisted
    // invoice, so it is also the local row key. That keeps cache reconciliation
    // a plain id match instead of a second identifier scheme.
    id: summary.invoice_id,
    no: String(summary.invoice_number || '').trim() || 'Invoice to identify',
    party: String(summary.buyer_name || '').trim() || 'Buyer to confirm',
    gstin: String(summary.buyer_gstin || '').trim() || 'Unregistered',
    date: isoDate,
    isoDate,
    amount: taxable,
    tax,
    cgst,
    sgst,
    igst,
    cess,
    taxHeadsCaptured: [cgst, sgst, igst, cess].some(value => value > 0),
    totalWritten: grandTotal || taxable + tax,
    bucket: 'Review',
    status: direction === 'purchase' ? 'purchase' : 'review',
    issues: [],
    source: document?.filename || 'BillSetu business record',
    confidence: 82,
    color: 'mint',
    kind: 'Tax invoice',
    supplier: String(summary.supplier_name || '').trim(),
    supplierGstin: '',
    supplierStateCode: '',
    supplierAddress: '',
    buyerAddress: '',
    pos: STATE_CODES[posStateCode] || '',
    posStateCode,
    hsn: '',
    direction,
    rawText: '',
    items: [],
    backendDocumentId: summary.document_id || '',
    backendInvoiceId: summary.invoice_id,
    businessId: metadata.businessId || '',
    extractionSource: 'backend',
    serverLoadedAt: metadata.loadedAt || '',
  };

  return mapBackendValidationToFrontendInvoice(
    frontendInvoice,
    metadata.validation || null,
    metadata.validationError || SERVER_VALIDATION_PENDING,
  );
}
