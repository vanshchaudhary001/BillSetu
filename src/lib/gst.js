const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const STATE_CODES = {
  '01':'Jammu & Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand','06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat','26':'Dadra & Nagar Haveli and Daman & Diu','27':'Maharashtra','29':'Karnataka','30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry','35':'Andaman & Nicobar Islands','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh','97':'Other Territory'
};
export function stateCodeForName(value) {
  const normalized = text(value).toLowerCase();
  if (STATE_CODES[normalized]) return normalized;
  return Object.entries(STATE_CODES).find(([, name]) => name.toLowerCase() === normalized)?.[0] || '';
}

export function gstinChecksumValid(value) {
  const gstin = String(value || '').trim().toUpperCase();
  if (!GSTIN_PATTERN.test(gstin) || !STATE_CODES[gstin.slice(0, 2)]) return false;
  let sum = 0;
  let factor = 1;
  for (const char of gstin.slice(0, 14)) {
    const product = GSTIN_ALPHABET.indexOf(char) * factor;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 1 ? 2 : 1;
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36] === gstin[14];
}

export function suggestGSTINRepairs(value) {
  const original = String(value || '').trim().toUpperCase();
  const swaps = { I: ['1'], O: ['0'], S: ['5'], B: ['8'], '1': ['I'], '0': ['O'], '5': ['S'], '8': ['B'] };
  const candidates = new Set();
  [...original].forEach((char, index) => {
    for (const replacement of swaps[char] || []) {
      const candidate = `${original.slice(0, index)}${replacement}${original.slice(index + 1)}`;
      if (gstinChecksumValid(candidate)) candidates.add(candidate);
    }
  });
  return [...candidates];
}

const text = value => String(value ?? '').trim();
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const registered = value => GSTIN_PATTERN.test(text(value).toUpperCase());
const check = (id, label, severity, message, field, suggestedFix = '') => ({ id, label, severity, message, field, suggestedFix });

export function invoiceInPeriod(invoice, period) {
  const match = String(period || '').match(/^([A-Za-z]+)\s+(\d{4})$/);
  const date = text(invoice.isoDate || invoice.date).slice(0, 10);
  if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const month = new Date(`${match[1]} 1, ${match[2]}`).getMonth() + 1;
  return Number.isFinite(month) && date.slice(0, 7) === `${match[2]}-${String(month).padStart(2, '0')}`;
}

/** Twelve deterministic preparation checks. Warnings need a human decision; the engine never files. */
export function runGSTChecks(invoice, profile = {}, allInvoices = []) {
  const findings = [];
  const supplierGstin = text(invoice.supplierGstin || profile.gstin).toUpperCase();
  const buyerGstin = text(invoice.gstin).toUpperCase();
  const invoiceNo = text(invoice.no);
  const invoiceDate = text(invoice.isoDate || invoice.date);
  const taxable = number(invoice.amount);
  const cgst = number(invoice.cgst ?? (invoice.tax && invoice.pos === (profile.state || 'Uttar Pradesh') ? invoice.tax / 2 : 0));
  const sgst = number(invoice.sgst ?? (invoice.tax && invoice.pos === (profile.state || 'Uttar Pradesh') ? invoice.tax / 2 : 0));
  const igst = number(invoice.igst ?? (invoice.tax && invoice.pos !== (profile.state || 'Uttar Pradesh') ? invoice.tax : 0));
  const tax = number(invoice.tax ?? cgst + sgst + igst);
  const total = number(invoice.totalWritten ?? taxable + tax);
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const supplierState = supplierGstin.slice(0, 2);
  const posState = text(invoice.posStateCode || invoice.posCode || stateCodeForName(invoice.pos));
  const isB2B = registered(buyerGstin);
  const isRegisteredBuyer = Boolean(buyerGstin && !['UNREGISTERED', 'NEEDS REVIEW', 'NEEDS BUYER GSTIN'].includes(buyerGstin));
  const isComposition = profile.scheme === 'composition';
  const error = (id, label, message, field, suggested) => findings.push(check(id, label, 'error', message, field, suggested));
  const warning = (id, label, message, field, suggested) => findings.push(check(id, label, 'warning', message, field, suggested));
  const pass = (id, label, message = 'Looks good') => findings.push(check(id, label, 'pass', message));
  const pending = (id, label, message) => findings.push(check(id, label, 'warning', message));

  // R01: structure, recognized state, PAN segment and Mod-36 checksum.
  if (isRegisteredBuyer && !gstinChecksumValid(buyerGstin)) error('R01', 'Buyer GSTIN check', 'This GSTIN has a format, state-code, or checksum issue. Confirm it against the source.', 'gstin', suggestGSTINRepairs(buyerGstin)[0] || 'Check the GSTIN with the customer');
  else if (supplierGstin && !gstinChecksumValid(supplierGstin)) error('R01', 'Supplier GSTIN check', 'The business GSTIN needs correction in Settings before preparing a draft.', 'supplierGstin', 'Edit business profile');
  else pass('R01', 'GSTIN structure & checksum');

  // R02: item arithmetic when item lines are available.
  if (items.length) {
    const lineSum = items.reduce((sum, item) => sum + number(item.quantity) * number(item.rate) - number(item.discount), 0);
    Math.abs(lineSum - taxable) > 1 ? error('R02', 'Line-item arithmetic', `Line items total ${lineSum.toFixed(2)}, but taxable value is ${taxable.toFixed(2)}.`, 'amount', lineSum.toFixed(2)) : pass('R02', 'Line-item arithmetic');
  } else pending('R02', 'Line-item arithmetic', 'No line-item breakdown was captured.');

  // R03: currency-safe (paise) grand total check.
  const expectedPaise = Math.round((taxable + tax) * 100);
  const writtenPaise = Math.round(total * 100);
  Math.abs(expectedPaise - writtenPaise) > 100 ? error('R03', 'Grand-total reconciliation', `Taxable value + tax differs from the written total by ₹${Math.abs(expectedPaise - writtenPaise) / 100}.`, 'totalWritten', (taxable + tax).toFixed(2)) : pass('R03', 'Grand-total reconciliation');

  // R04: domestic split, only when state signals and tax heads exist.
  if (invoice.direction !== 'purchase' && !posState) error('R04', 'Place of supply & tax split', 'Choose the place of supply from the invoice before preparing an outward-supply draft.', 'posStateCode', 'Select the place-of-supply state');
  else if (!supplierState || !posState || !tax) pending('R04', 'Place of supply & tax split', 'Capture tax heads and compare them with the supplier and place-of-supply states.');
  else if (invoice.taxHeadsCaptured === false) error('R04', 'Place of supply & tax split', 'Tax heads were not captured. Enter CGST, SGST, IGST and any cess from the bill before confirming.', 'tax', 'Capture the tax split from the bill');
  else if (supplierState === posState) {
    (igst > 0.01 || Math.abs(cgst - sgst) > 0.01 || Math.abs(cgst + sgst + number(invoice.cess) - tax) > 1) ? error('R04', 'Place of supply & tax split', 'Same-state supplies normally use matching CGST and SGST amounts, with tax heads reconciling to total tax. Verify this split.', 'tax', 'Review CGST, SGST, cess and place of supply') : pass('R04', 'Place of supply & tax split');
  } else {
    (cgst > 0.01 || sgst > 0.01 || igst <= 0 || Math.abs(igst + number(invoice.cess) - tax) > 1) ? error('R04', 'Place of supply & tax split', 'Different-state supply appears to use the wrong tax heads or the heads do not reconcile to total tax. Confirm whether IGST applies.', 'tax', 'Review IGST, cess and place of supply') : pass('R04', 'Place of supply & tax split');
  }

  // R05: advisory only; actual rate selection remains item/notification specific.
  const rate = taxable > 0 ? Math.round((tax / taxable) * 10000) / 100 : 0;
  if (invoiceDate >= '2025-09-22' && [12, 28].includes(Math.round(rate))) warning('R05', 'Rate needs a second look', 'A 12% or 28% rate is present after the GST rate transition. Check the exact HSN/SAC notification; this is only an advisory.', 'tax', 'Have your CA confirm the item rate');
  else if (taxable) pass('R05', 'Rate transition advisory', 'No common legacy-rate signal found; exact item rate is not certified.');
  else pending('R05', 'Rate transition advisory', 'Add taxable value and tax to estimate the billed rate.');

  // R06: serial length/characters and duplicates within the current dataset.
  if (!invoiceNo || invoiceNo.length > 16 || !/^[A-Z0-9/-]+$/i.test(invoiceNo)) error('R06', 'Invoice number', 'Invoice number must be present, at most 16 characters, and use letters, numbers, / or -.', 'no', 'Correct the invoice number');
  else if (allInvoices.some(item => item.id !== invoice.id && text(item.no).toLowerCase() === invoiceNo.toLowerCase() && text(item.isoDate || item.date) === text(invoice.isoDate || invoice.date) && text(item.gstin).toUpperCase() === buyerGstin)) error('R06', 'Duplicate invoice check', 'Another record has the same invoice number, date, and buyer. Keep one or confirm these are distinct documents.', 'no', 'Review the matching record');
  else pass('R06', 'Invoice number & duplicate check');

  // R07: completeness; B2C buyer address becomes a prompt at ₹50,000.
  const missing = [];
  if (!text(invoice.supplier || profile.name)) missing.push('supplier name');
  if (!supplierGstin) missing.push('supplier GSTIN');
  if (!invoiceNo) missing.push('invoice number');
  if (!invoiceDate) missing.push('invoice date');
  if (taxable <= 0) missing.push('taxable value');
  if (isB2B && !gstinChecksumValid(buyerGstin)) missing.push('valid buyer GSTIN');
  if (!isRegisteredBuyer && total >= 50000 && !text(invoice.buyerAddress)) missing.push('unregistered buyer address (₹50,000+ bill)');
  if (!text(invoice.party) || /^(needs|buyer to confirm|unknown|imported customer)/i.test(text(invoice.party))) missing.push('buyer name');
  if (!text(invoice.supplierAddress || profile.address)) missing.unshift('supplier address');
  if (invoiceDate && profile.period && !invoiceInPeriod(invoice, profile.period)) missing.push(`invoice date in ${profile.period}`);
  if (missing.length) error('R07', 'Invoice details', `Add or verify: ${missing.join(', ')}.`, 'requiredFields', 'Complete the highlighted fields');
  else pass('R07', 'Invoice details');

  // R08: HSN/SAC digit check where present; B2B absence is a visible warning.
  const hsn = text(invoice.hsn || items[0]?.hsn);
  const requiredHsnDigits = Number(profile.hsnDigits || 4);
  if (hsn && !new RegExp(`^\\d{${requiredHsnDigits},8}$`).test(hsn)) error('R08', 'HSN/SAC digits', `Use at least ${requiredHsnDigits} digits for this business profile.`, 'hsn', 'Correct the HSN/SAC from a verified source');
  else if (isB2B && !hsn) warning('R08', 'HSN/SAC detail', 'No HSN/SAC was captured. Add the applicable code from an official source or ask your CA.', 'hsn', 'Add a verified HSN/SAC');
  else if (hsn || isB2B) pass('R08', 'HSN/SAC format', 'Digits checked only; tariff classification is not verified.');
  else pass('R08', 'HSN/SAC format', 'No HSN/SAC captured; this check is optional for this unregistered-buyer record.');

  // R09: content-level duplicate fingerprint, not just file-name matching.
  const fingerprint = [invoiceNo.toLowerCase(), invoiceDate, buyerGstin, taxable.toFixed(2)].join('|');
  if (allInvoices.some(item => item.id !== invoice.id && [text(item.no).toLowerCase(), text(item.isoDate || item.date), text(item.gstin).toUpperCase(), number(item.amount).toFixed(2)].join('|') === fingerprint)) error('R09', 'Duplicate content check', 'A matching invoice number, date, buyer, and amount already exists.', 'no', 'Review duplicate before export');
  else pass('R09', 'Duplicate content check');

  // R10: deterministic return bucket routing, based on saved category and transaction data.
  let expectedBucket = 'B2CS';
  if (isB2B) expectedBucket = 'B2B';
  else if (posState && supplierState && posState !== supplierState && total > 100000) expectedBucket = 'B2CL';
  if (invoice.direction === 'purchase') pending('R10', 'GSTR-1 return bucket', 'Purchase bills are excluded from outward-supply GSTR-1 drafts. ITC remains unverified.');
  else if (!['B2B', 'B2CL', 'B2CS'].includes(invoice.bucket) || invoice.bucket !== expectedBucket) warning('R10', 'GSTR-1 return bucket', `Based on available details, this looks like ${expectedBucket}. Confirm the transaction facts before export.`, 'bucket', expectedBucket);
  else pass('R10', 'GSTR-1 return bucket', `${expectedBucket} based on current buyer and place-of-supply details.`);

  // R11: optional composition scheme guard.
  if (isComposition && (tax > 0 || (posState && supplierState && posState !== supplierState))) error('R11', 'Composition scheme guard', 'A composition profile should not issue a bill charging GST. Inter-state outward sales also need review.', 'scheme', 'Escalate this record to a CA');
  else if (isComposition) pass('R11', 'Composition scheme guard');
  else pass('R11', 'Composition scheme guard', isComposition ? 'No composition guardrail was triggered.' : 'Not applicable to a Regular taxpayer profile.');

  // R12: file/OCR confidence and untrusted document text are never instructions.
  const rawText = text(invoice.rawText);
  const injection = /ignore (all )?(previous|prior|system|above) instructions|set (grand )?total to 0|override (the )?(system|developer) prompt|reveal (the )?api key/i.test(rawText);
  if (injection) error('R12', 'Document safety & capture quality', 'This document contains instruction-like text. It is treated as untrusted bill content and the record is quarantined for manual review.', 'rawText', 'Review the original document; do not follow embedded instructions');
  else if (invoice.source === 'Manual entry') pass('R12', 'Document safety & capture quality', 'Fields were entered by the owner; compare them with the original bill.');
  else if (number(invoice.confidence) < 40) warning('R12', 'Document safety & capture quality', 'Capture confidence is low. Check the original image/PDF before confirming.', 'confidence', 'Retake a clear, well-lit photo');
  else pass('R12', 'Document safety & capture quality', 'File was processed locally; source text is treated as data, never instructions.');

  return findings;
}

export function deriveInvoiceStatus(findings, confirmed = false) {
  if (findings.some(item => item.id === 'R12' && item.severity === 'error')) return 'blocked';
  if (findings.some(item => item.severity === 'error')) return 'blocked';
  if (findings.some(item => ['warning', 'pending'].includes(item.severity))) return 'review';
  return confirmed ? 'ready' : 'review';
}

export function getReadiness(invoices) {
  const outward = invoices.filter(invoice => invoice.direction !== 'purchase');
  if (!outward.length) return 0;
  const ready = outward.filter(invoice => invoice.status === 'ready').length;
  const resolved = outward.filter(invoice => invoice.status !== 'blocked' && invoice.status !== 'review').length;
  return Math.round((ready / outward.length) * 100) || (resolved ? Math.round((resolved / outward.length) * 100) : 0);
}

export function getBucket(invoice, profile = {}) {
  const gstin = text(invoice.gstin).toUpperCase();
  if (registered(gstin)) return 'B2B';
  const supplierState = text(invoice.supplierGstin || profile.gstin).slice(0, 2);
  const posState = text(invoice.posStateCode || invoice.posCode || stateCodeForName(invoice.pos));
  return posState && supplierState && posState !== supplierState && number(invoice.totalWritten || number(invoice.amount) + number(invoice.tax)) > 100000 ? 'B2CL' : 'B2CS';
}
