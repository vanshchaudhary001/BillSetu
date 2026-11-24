import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, BadgeCheck, Bell, BookOpenCheck,
  Building2, CalendarDays, Check, CheckCheck, CheckCircle2, ChevronDown, CircleAlert,
  CircleHelp, ClipboardList, CloudUpload, Download, FileCheck2, FileDown, FileSpreadsheet,
  FileText, Gauge, Globe2, HardDrive, HelpCircle, History, Home, Languages, LayoutDashboard,
  ListFilter, LockKeyhole, MoreHorizontal, Plus, ReceiptText, RotateCcw, Search, Settings2,
  ShieldCheck, Sparkles, Trash2, Upload, X, Zap
} from 'lucide-react';
import { deriveInvoiceStatus, getBucket, getReadiness, invoiceInPeriod, runGSTChecks, STATE_CODES, gstinChecksumValid, suggestGSTINRepairs } from './lib/gst.js';
import { demoInjectionInvoice, demoInvoice, normalizeDate, parseRegister, scanDocument, validateFile } from './lib/intake.js';
import { deleteLocalDocument, loadLocalDocument, readLocalState, saveLocalDocument, writeLocalState, clearLocalWorkspace } from './lib/storage.js';
import { downloadBlob, makeCAWorkbook, makeGstr1Draft } from './lib/exports.js';
import { ApiError, exportInvoiceCsv, exportInvoiceJson, extractDocument, getDocumentAudit, getDocumentContent, getInvoiceAudit, getInvoiceGstr1, healthCheck, uploadDocument, validateInvoice } from './lib/api.js';
import { mapBackendGstr1ToFrontendInvoice, mapBackendValidationToFrontendInvoice, mapCanonicalInvoiceToFrontendInvoice, markBackendGstr1Unavailable } from './lib/mappers.js';
import './styles.css';
import './app.css';

const PROFILE_SEED = { name: 'Sharma Electricals', gstin: '09ABCDE1234F1ZY', state: 'Uttar Pradesh', address: '14 Market Road, Lucknow, Uttar Pradesh 226001', scheme: 'regular', turnover: 'under-5cr', hsnDigits: 4, filing: 'Monthly', period: 'October 2026' };
const makeInvoice = fields => ({ id: crypto.randomUUID(), direction: 'sale', status: 'review', issues: [], confidence: 82, kind: 'Tax invoice', source: 'Manual entry', items: [], ...fields });
const DEMO_INVOICES = [
  makeInvoice({ id: 'inv-041', no: 'SH/26-27/0041', party: 'Aarav Electricals', gstin: '09XYZAB5678KIZN', date: '2026-10-20', isoDate: '2026-10-20', amount: 45000, tax: 5400, cgst: 2700, sgst: 2700, igst: 0, totalWritten: 49800, bucket: 'B2B', status: 'blocked', issues: ['GSTIN checksum needs verification', 'Invoice total differs by ₹600', '12% rate advisory'], source: 'Synthetic demo invoice', confidence: 72, color: 'mint', kind: 'Handwritten tax invoice', supplier: PROFILE_SEED.name, supplierGstin: PROFILE_SEED.gstin, supplierStateCode: '09', supplierAddress: PROFILE_SEED.address, pos: 'Uttar Pradesh', posStateCode: '09', hsn: '8536', rawText: 'Synthetic record for the demo. No real taxpayer data.', items: [{ description: 'Electrical fittings', quantity: 1, rate: 45000, discount: 0, hsn: '8536' }], totalWritten: 49800 }),
  makeInvoice({ id: 'inv-038', no: 'INV/26-27/108', party: 'Mehta Traders', gstin: '27AAKFM2916L1ZY', date: '2026-10-19', isoDate: '2026-10-19', amount: 128400, tax: 23112, cgst: 0, sgst: 0, igst: 23112, totalWritten: 151512, bucket: 'B2B', status: 'ready', confirmed: true, issues: [], source: 'Synthetic demo invoice', confidence: 98, color: 'blue', supplier: PROFILE_SEED.name, supplierGstin: PROFILE_SEED.gstin, pos: 'Maharashtra', posStateCode: '27', hsn: '8536', items: [{ description: 'Electrical parts', quantity: 1, rate: 128400, discount: 0, hsn: '8536' }] }),
  makeInvoice({ id: 'inv-036', no: 'ST/1198', party: 'Walk-in customer', gstin: 'Unregistered', date: '2026-10-18', isoDate: '2026-10-18', amount: 62000, tax: 11160, cgst: 5580, sgst: 5580, igst: 0, totalWritten: 73160, bucket: 'B2CS', status: 'review', issues: ['Confirm buyer address for this high-value retail bill'], source: 'Synthetic demo register', confidence: 88, color: 'amber', supplier: PROFILE_SEED.name, supplierGstin: PROFILE_SEED.gstin, pos: 'Uttar Pradesh', posStateCode: '09', hsn: '8536', buyerAddress: '', items: [{ description: 'Lighting supplies', quantity: 1, rate: 62000, discount: 0, hsn: '8536' }] }),
  makeInvoice({ id: 'inv-032', no: 'SE/26-27/032', party: 'Northstar Components', gstin: '07AABCN8542F1ZH', date: '2026-10-17', isoDate: '2026-10-17', amount: 216000, tax: 38880, cgst: 0, sgst: 0, igst: 38880, totalWritten: 254880, bucket: 'B2B', status: 'ready', confirmed: true, issues: [], source: 'Synthetic demo invoice', confidence: 96, color: 'lavender', supplier: PROFILE_SEED.name, supplierGstin: PROFILE_SEED.gstin, pos: 'Delhi', posStateCode: '07', hsn: '8536', items: [{ description: 'Switchgear', quantity: 1, rate: 216000, discount: 0, hsn: '8536' }] }),
  makeInvoice({ id: 'inv-029', no: 'SH/26-27/0038', party: 'Walk-in customer', gstin: 'Unregistered', date: '2026-10-16', isoDate: '2026-10-16', amount: 145000, tax: 26100, cgst: 0, sgst: 0, igst: 26100, totalWritten: 171100, bucket: 'B2CL', status: 'ready', confirmed: true, issues: [], source: 'Synthetic demo invoice', confidence: 91, color: 'coral', supplier: PROFILE_SEED.name, supplierGstin: PROFILE_SEED.gstin, pos: 'Maharashtra', posStateCode: '27', buyerAddress: 'Mumbai, Maharashtra', hsn: '8536', items: [{ description: 'Electrical goods', quantity: 1, rate: 145000, discount: 0, hsn: '8536' }] }),
  makeInvoice({ id: 'inv-026', no: 'PUR/26-27/079', party: 'Om Sai Distributors', gstin: '09AAEFO4498P1ZB', date: '2026-10-15', isoDate: '2026-10-15', amount: 38750, tax: 6975, cgst: 3487.5, sgst: 3487.5, igst: 0, totalWritten: 45725, bucket: 'Purchase', status: 'purchase', issues: [], source: 'Synthetic purchase invoice', confidence: 97, color: 'blue', kind: 'Purchase invoice', supplier: 'Om Sai Distributors', supplierGstin: '09AAEFO4498P1ZB', supplierStateCode: '09', pos: 'Uttar Pradesh', posStateCode: '09', direction: 'purchase', items: [{ description: 'Electrical components', quantity: 1, rate: 38750, discount: 0, hsn: '8536' }] }),
];

const EN = { overview: 'Overview', invoices: 'All records', attention: 'Needs attention', reports: 'Exports', rules: 'GST rule guide', ca: 'CA workspace', help: 'Help centre', settings: 'Business settings' };
const HI = { overview: 'डैशबोर्ड', invoices: 'सभी रिकॉर्ड', attention: 'ध्यान दें', reports: 'एक्सपोर्ट', rules: 'GST नियम गाइड', ca: 'CA वर्कस्पेस', help: 'सहायता केंद्र', settings: 'व्यापार सेटिंग' };
const RULES = [
  ['R01','GSTIN structure & checksum','Format, state code, PAN structure and Mod-36 checksum. A portal lookup is still required to confirm active status.'],
  ['R02','Line-item arithmetic','Quantity × rate − discount is compared with the captured taxable value.'],
  ['R03','Grand-total reconciliation','Taxable value and tax heads are checked against the bill total in paise.'],
  ['R04','Place of supply & tax split','Same-state CGST/SGST and different-state IGST signals are checked; complex cases go to a CA.'],
  ['R05','Rate transition advisory','12% or 28% on a post-22 Sep 2025 record is an advisory only. Exact HSN/SAC rate is not certified.'],
  ['R06','Invoice number & duplicate','Length/characters and matching invoice number, buyer, date and amount are checked.'],
  ['R07','Invoice details','Required capture fields are checked, including a B2C address prompt at ₹50,000+.'],
  ['R08','HSN/SAC digits','Digit length is checked using the business profile. This does not determine tariff classification.'],
  ['R09','Duplicate content','A composite invoice fingerprint catches repeat imports before draft export.'],
  ['R10','GSTR-1 bucket','Available details suggest B2B, B2CL or B2CS. Review unusual supply facts before export.'],
  ['R11','Composition guard','Flags GST collected or inter-state outward sales on a Composition profile.'],
  ['R12','Document safety & confidence','Suspicious instruction-like text is quarantined; low OCR confidence requires human review.'],
];
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
const fmtDate = value => { const d = new Date(`${String(value || '').slice(0,10)}T00:00:00`); return Number.isNaN(d.valueOf()) ? 'Date to confirm' : d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); };
const stateCodeFor = value => Object.entries(STATE_CODES).find(([, state]) => state.toLowerCase() === String(value || '').trim().toLowerCase())?.[0] || '';
const statusName = status => ({ ready: 'Ready', blocked: 'Blocked', review: 'Review', purchase: 'Purchase' }[status] || 'Review');
const invoiceFindings = (invoice, profile, invoices) => invoice?.validationAuthority === 'backend'
  ? (Array.isArray(invoice.findings) ? invoice.findings : [])
  : runGSTChecks(invoice, profile, invoices);

function downloadText(text, type, filename) { downloadBlob(new Blob([text], { type }), filename); }
function backendExportFilename(invoice, format) {
  const component = String(invoice.no || invoice.backendInvoiceId || 'invoice')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/[._]+$/, '')
    .slice(0, 64) || 'invoice';
  return `billsetu_${component}_gstr1.${format}`;
}
function validateBackendAuditEvents(events) {
  const validMetadata = metadata => metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && Object.values(metadata).every(value => value === null
      || typeof value === 'string'
      || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value));
  const validEvents = Array.isArray(events) && events.every(event => event
    && typeof event === 'object'
    && typeof event.event_id === 'string'
    && typeof event.document_id === 'string'
    && (event.invoice_id === null || typeof event.invoice_id === 'string')
    && typeof event.event_type === 'string'
    && typeof event.status === 'string'
    && typeof event.message === 'string'
    && typeof event.created_at === 'string'
    && Number.isFinite(Date.parse(event.created_at))
    && validMetadata(event.metadata));
  if (!validEvents) throw new Error('The backend returned an unexpected audit response.');
  return events;
}
function Avatar({ children = 'RS' }) { return <span className="avatar-v2">{children}</span>; }

export default function App() {
  const [invoices, setInvoices] = useState(() => {
    const saved = readLocalState('invoices', null);
    if (!Array.isArray(saved)) return DEMO_INVOICES;
    return saved.map(item => {
      const isoDate = normalizeDate(item.isoDate || item.date);
      const normalized = { ...item, id: item.id || crypto.randomUUID(), no: item.no || 'Invoice to identify', party: item.party || 'Buyer to confirm', gstin: item.gstin || 'Unregistered', date: isoDate || item.date || '', isoDate, direction: item.direction || 'sale', status: item.status || 'review', issues: Array.isArray(item.issues) ? item.issues : [], items: Array.isArray(item.items) ? item.items : [], source: item.source || 'Saved local record', confidence: item.confidence ?? 0, taxHeadsCaptured: item.taxHeadsCaptured ?? [item.cgst, item.sgst, item.igst, item.cess].some(value => Number(value || 0) > 0) };
      if (normalized.validationAuthority === 'backend' || normalized.extractionSource === 'backend') {
        if (normalized.backendValidation) {
          try {
            return mapBackendValidationToFrontendInvoice(normalized, normalized.backendValidation);
          } catch (error) {
            return mapBackendValidationToFrontendInvoice(normalized, null, `Saved backend validation is invalid: ${error.message}`);
          }
        }
        return mapBackendValidationToFrontendInvoice(
          normalized,
          null,
          normalized.backendValidationError || 'This saved backend extraction has no validation result. Re-upload it to obtain an authoritative result.',
        );
      }
      return makeInvoice(normalized);
    });
  });
  const [profile, setProfile] = useState(() => ({ ...PROFILE_SEED, ...readLocalState('profile', {}) }));
  const [preferences, setPreferences] = useState(() => ({ language: 'en', replay: true, ...readLocalState('preferences', {}) }));
  const [audit, setAudit] = useState(() => readLocalState('audit', [{ id: 'seed-1', at: '2026-10-20T10:15:00.000Z', invoice: 'INV/26-27/108', action: 'Demo record confirmed', details: 'Synthetic sample data loaded into this browser.' }]));
  const [view, setView] = useState('overview');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState('');
  const [notice, setNotice] = useState('');
  const [scanProgress, setScanProgress] = useState(null);
  const [scanError, setScanError] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileDraft, setProfileDraft] = useState(profile);
  const [ruleQuery, setRuleQuery] = useState('');
  const [backendState, setBackendState] = useState('checking');
  const [toastTimer, setToastTimer] = useState(0);
  const fileInput = useRef(null);
  const searchInput = useRef(null);
  const backendGstr1Requests = useRef(new Set());
  const sourcePreviewRequests = useRef(new Set());
  const activeInvoice = invoices.find(invoice => invoice.id === activeId);
  const labels = preferences.language === 'hi' ? HI : EN;
  const checks = activeInvoice ? invoiceFindings(activeInvoice, profile, invoices) : [];
  const periodInvoices = invoices.filter(item => invoiceInPeriod(item, profile.period));
  const periodOutward = periodInvoices.filter(item => item.direction !== 'purchase');
  const issueCount = invoices.filter(item => item.direction !== 'purchase' && (item.status !== 'ready' || !invoiceInPeriod(item, profile.period))).length;
  const readyCount = periodOutward.filter(item => item.status === 'ready' && item.confirmed).length;
  const readiness = getReadiness(periodInvoices);
  const totalSales = periodOutward.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const visibleInvoices = useMemo(() => invoices.filter(item => {
    const matchesSearch = `${item.no} ${item.party} ${item.gstin} ${item.source}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === 'all' || (filter === 'attention' ? item.status !== 'ready' && item.direction !== 'purchase' : filter === 'ready' ? item.status === 'ready' : filter === 'purchase' ? item.direction === 'purchase' : item.status === filter);
    const matchesView = view !== 'attention' || (item.status !== 'ready' && item.direction !== 'purchase');
    return matchesSearch && matchesFilter && matchesView;
  }), [invoices, query, filter, view]);

  useEffect(() => {
    writeLocalState('invoices', invoices.map(({ fileUrl, sourceMediaType, sourcePreviewError, sourcePreviewStatus, ...invoice }) => invoice));
  }, [invoices]);
  useEffect(() => { writeLocalState('profile', profile); }, [profile]);
  useEffect(() => { writeLocalState('preferences', preferences); }, [preferences]);
  useEffect(() => { writeLocalState('audit', audit.slice(0, 500)); }, [audit]);
  useEffect(() => {
    let active = true;
    healthCheck()
      .then(result => { if (active) setBackendState(result?.status === 'ok' ? 'connected' : 'unavailable'); })
      .catch(() => { if (active) setBackendState('unavailable'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const pending = invoices.filter(item => item.validationAuthority === 'backend'
      && item.backendValidation
      && item.backendGstr1Status === 'pending'
      && !backendGstr1Requests.current.has(item.id));
    if (!pending.length) return;

    pending.forEach(item => backendGstr1Requests.current.add(item.id));
    setInvoices(current => current.map(item => pending.some(candidate => candidate.id === item.id)
      ? { ...item, backendGstr1Status: 'loading' }
      : item));

    pending.forEach(async invoice => {
      try {
        const response = await getInvoiceGstr1(invoice.backendInvoiceId);
        const mapped = mapBackendGstr1ToFrontendInvoice({}, response);
        setInvoices(current => current.map(item => item.id === invoice.id
          ? mapBackendGstr1ToFrontendInvoice(item, mapped.backendGstr1)
          : item));
      } catch (error) {
        const detail = error instanceof ApiError && typeof error.detail === 'string' && error.detail
          ? ` ${error.detail}`
          : '';
        const unavailable = markBackendGstr1Unavailable({}, `${error.message || 'The backend GSTR-1 request failed.'}${detail}`);
        setInvoices(current => current.map(item => item.id === invoice.id
          ? markBackendGstr1Unavailable(item, unavailable.backendGstr1Error)
          : item));
      }
    });
  }, [invoices]);
  useEffect(() => {
    setInvoices(current => current.map(item => {
      if (item.direction === 'purchase' || item.validationAuthority === 'backend' || invoiceInPeriod(item, profile.period) || (!item.confirmed && item.status !== 'ready')) return item;
      const findings = runGSTChecks(item, profile, current);
      return { ...item, confirmed: false, status: deriveInvoiceStatus(findings, false), issues: findings.filter(finding => ['error', 'warning'].includes(finding.severity)).map(finding => finding.label) };
    }));
    // Reconcile saved confirmations with the selected filing month on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const handleShortcut = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.current?.focus(); }
      if (event.key === 'Escape' && document.activeElement === searchInput.current) { setQuery(''); searchInput.current?.blur(); }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);
  useEffect(() => {
    invoices.filter(item => item.id === activeId
      && item.backendDocumentId
      && !item.fileUrl
      && item.sourcePreviewStatus !== 'unavailable'
      && !sourcePreviewRequests.current.has(item.id)).forEach(item => {
      sourcePreviewRequests.current.add(item.id);
      getDocumentContent(item.backendDocumentId).then(blob => {
        if (!blob.type.startsWith('image/') && blob.type !== 'application/pdf') {
          throw new ApiError('This uploaded document type cannot be previewed.', 415);
        }
        const fileUrl = URL.createObjectURL(blob);
        setInvoices(current => {
          if (!current.some(row => row.id === item.id)) {
            URL.revokeObjectURL(fileUrl);
            return current;
          }
          return current.map(row => row.id === item.id
            ? { ...row, fileUrl, sourceMediaType: blob.type, sourcePreviewStatus: 'available', sourcePreviewError: '' }
            : row);
        });
      }).catch(error => {
        setInvoices(current => current.map(row => row.id === item.id
          ? {
            ...row,
            sourcePreviewStatus: 'unavailable',
            sourcePreviewError: error.message || 'The original source document is unavailable.',
          }
          : row));
      }).finally(() => sourcePreviewRequests.current.delete(item.id));
    });
  }, [activeId, invoices]);
  useEffect(() => {
    let cancelled = false;
    invoices.filter(item => !item.backendDocumentId && item.fileKey && !item.fileUrl).forEach(async item => {
      try { const blob = await loadLocalDocument(item.fileKey); if (!cancelled && blob) setInvoices(current => current.map(row => row.id === item.id ? { ...row, fileUrl: URL.createObjectURL(blob) } : row)); } catch { /* local file may have been cleared */ }
    });
    return () => { cancelled = true; };
  }, [invoices]);
  useEffect(() => () => { if (toastTimer) window.clearTimeout(toastTimer); }, [toastTimer]);

  const notify = (message, kind = 'success') => {
    setNotice(`${kind}|${message}`);
    if (toastTimer) window.clearTimeout(toastTimer);
    setToastTimer(window.setTimeout(() => setNotice(''), 4200));
  };
  const recordAction = (invoice, action, details) => setAudit(previous => [{ id: crypto.randomUUID(), at: new Date().toISOString(), invoice: invoice?.no || 'Workspace', action, details }, ...previous].slice(0, 500));
  const updateInvoice = (id, patch) => setInvoices(previous => previous.map(item => {
    if (item.id !== id) return item;
    const next = { ...item, ...patch };
    if (next.validationAuthority === 'backend') {
      next.status = item.status;
      if (patch.confirmed === false) next.backendValidationStale = true;
      return next;
    }
    if (patch.confirmed === true) return next;
    if (patch.confirmed === false || !next.confirmed) next.status = deriveInvoiceStatus(runGSTChecks(next, profile, previous), false);
    return next;
  }));
  const openInvoice = invoice => { setActiveId(invoice.id); setView('invoices'); };
  const goTo = destination => { setView(destination); setQuery(''); if (destination === 'invoices') setFilter('all'); if (destination === 'attention') setFilter('attention'); };
  const changeFilingPeriod = period => {
    const nextProfile = { ...profile, period };
    setProfile(nextProfile);
    setInvoices(previous => previous.map(item => {
      if (item.direction === 'purchase' || item.validationAuthority === 'backend') return item;
      const findings = runGSTChecks(item, nextProfile, previous);
      if (invoiceInPeriod(item, period) && item.confirmed && item.status === 'ready') return item;
      return { ...item, confirmed: false, status: deriveInvoiceStatus(findings, false), issues: findings.filter(finding => ['error', 'warning'].includes(finding.severity)).map(finding => finding.label) };
    }));
    recordAction(null, 'Changed filing period', `Current preparation period set to ${period}. Out-of-period sales require review.`);
  };

  const processFiles = async fileList => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setScanError('');
    if (files.length > 5) { setScanError('Add up to 5 files per batch so each record can be checked carefully.'); return; }
    const added = [];
    for (const file of files) {
      try {
        validateFile(file);
        setScanProgress({ name: file.name, percent: 0, phase: 'Checking file' });
        let result;
        let backendExtracted = false;
        try {
          setBackendState('checking');
          setScanProgress({ name: file.name, percent: 10, phase: 'Uploading document to BillSetu' });
          const uploaded = await uploadDocument(file);
          if (!uploaded?.document_id) throw new ApiError('The backend upload did not return a document ID.', 422);
          if (uploaded.status === 'quarantined') throw new ApiError('This document requires review and was quarantined by the backend.', 409);
          setScanProgress({ name: file.name, percent: 45, phase: 'Extracting invoice on BillSetu' });
          const extracted = await extractDocument(uploaded.document_id);
          if (!extracted?.invoice || typeof extracted.invoice !== 'object' || typeof extracted.invoice_id !== 'string' || !extracted.invoice_id.trim()) {
            throw new ApiError('The backend returned an unexpected extraction response.', 502);
          }
          const frontendInvoice = mapCanonicalInvoiceToFrontendInvoice(extracted.invoice, {
            documentId: uploaded.document_id,
            invoiceId: extracted.invoice_id,
            fileName: file.name,
          });
          setScanProgress({ name: file.name, percent: 75, phase: 'Validating invoice on BillSetu' });
          try {
            const validation = await validateInvoice(extracted.invoice_id);
            result = [mapBackendValidationToFrontendInvoice(frontendInvoice, validation)];
            setBackendState('connected');
          } catch (error) {
            const message = error.message || 'The backend validation request failed.';
            result = [mapBackendValidationToFrontendInvoice(frontendInvoice, null, message)];
            setScanError(`${file.name}: validation failed. The extracted invoice was saved for review but cannot be confirmed. ${message}`);
            setBackendState(error instanceof ApiError && error.status === 0 ? 'unavailable' : 'connected');
          }
          backendExtracted = true;
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            setBackendState('connected');
            let key = '';
            try { key = crypto.randomUUID(); await saveLocalDocument(key, file); } catch { key = ''; }
            const blobUrl = backendExtracted ? '' : URL.createObjectURL(file);
            added.push({
              id: `quarantine-${crypto.randomUUID()}`,
              no: 'QUARANTINE', party: 'Buyer to confirm', gstin: 'Unregistered',
              date: '', isoDate: '', amount: 0, tax: 0, cgst: 0, sgst: 0, igst: 0, cess: 0,
              taxHeadsCaptured: false, totalWritten: 0, bucket: 'Review',
              status: 'blocked', issues: ['Backend quarantine - document requires manual review'],
              source: file.name, confidence: 0, color: 'coral',
              kind: 'Quarantined document', supplier: profile.name,
              supplierGstin: profile.gstin, supplierStateCode: profile.gstin.slice(0, 2),
              supplierAddress: profile.address, pos: '', posStateCode: '',
              hsn: '', direction: 'sale', rawText: '', items: [],
              fileKey: key, fileUrl: blobUrl, sourcePersistenceFailed: !key,
              extractionSource: 'backend',
              validationAuthority: 'backend',
              backendQuarantined: true,
              backendValidationError: 'The backend quarantined this document before extraction.',
            });
            setScanError(`${file.name}: document requires review and was quarantined by the backend.`);
            continue;
          }
          setBackendState(error instanceof ApiError && error.status === 0 ? 'unavailable' : 'connected');
          setScanProgress({ name: file.name, percent: 0, phase: 'Backend unavailable - reading bill on this device' });
          result = await scanDocument(file, percent => setScanProgress({ name: file.name, percent, phase: 'Reading bill on this device' }));
          const message = error instanceof ApiError ? error.message : 'The backend request failed.';
          setScanError(`${file.name}: ${message} Offline fallback is processing the document.`);
        }
        if (Array.isArray(result) && result[0]?.kind === 'Sales register row') {
          const rows = result.map(row => {
            const enriched = { ...row, supplier: profile.name, supplierGstin: profile.gstin, supplierStateCode: profile.gstin.slice(0, 2), supplierAddress: profile.address };
            enriched.bucket = getBucket(enriched, profile);
            enriched.findings = runGSTChecks(enriched, profile, [...invoices, ...added]);
            enriched.status = deriveInvoiceStatus(enriched.findings, false);
            enriched.issues = enriched.findings.filter(item => ['error', 'warning'].includes(item.severity)).map(item => item.label);
            return enriched;
          });
          added.push(...rows);
          continue;
        }
        let key = '';
        try { key = crypto.randomUUID(); await saveLocalDocument(key, file); }
        catch { key = ''; /* keep extracted fields even when the browser cannot persist the source */ }
        const blobUrl = URL.createObjectURL(file);
        const record = {
          ...result[0],
          fileKey: key,
          fileUrl: blobUrl,
          sourcePersistenceFailed: !key,
          supplier: result[0].supplier || profile.name,
          supplierGstin: result[0].supplierGstin || profile.gstin,
          supplierStateCode: result[0].supplierStateCode || profile.gstin.slice(0, 2),
          supplierAddress: profile.address,
          posStateCode: result[0].posStateCode || '',
          issues: result[0].injectionDetected
            ? result[0].issues
            : backendExtracted
              ? result[0].issues
              : ['Compare OCR fields with the original document'],
          status: result[0].injectionDetected ? 'blocked' : result[0].status || 'review',
        };
        if (backendExtracted) {
          record.validationAuthority = 'backend';
        } else {
          record.bucket = getBucket(record, profile);
          const findings = runGSTChecks(record, profile, [...invoices, ...added]);
          record.findings = findings;
          record.status = deriveInvoiceStatus(findings, false);
          record.issues = findings.filter(item => ['error', 'warning'].includes(item.severity)).map(item => item.label);
        }
        added.push(record);
      } catch (error) { setScanError(`${file.name}: ${error.message || 'Could not read this file.'}`); }
    }
    if (added.length) {
      setInvoices(previous => [...added, ...previous]);
      setView('invoices');
      if (added.length === 1 && added[0].direction !== 'purchase') setActiveId(added[0].id);
      added.forEach(item => recordAction(item, 'Imported for review', item.source));
      const sourceWarning = added.some(item => item.sourcePersistenceFailed);
      const validationFailed = added.some(item => item.validationAuthority === 'backend' && !item.backendValidation);
      notify(validationFailed
        ? 'The invoice was extracted, but backend validation failed. It remains in review and cannot be confirmed.'
        : sourceWarning
          ? 'Bill fields were read, but this browser could not save an original file copy. Keep the source document separately.'
          : `${added.length} ${added.length === 1 ? 'record' : 'records'} added. Check every field before confirming.`,
      validationFailed || sourceWarning ? 'error' : 'success');
    }
    setScanProgress(null);
  };

  const handleFileChange = event => { const files = event.target.files; processFiles(files); event.target.value = ''; };
  const deleteInvoice = async invoice => {
    if (!window.confirm(`Delete ${invoice.no} and its locally saved source file?`)) return;
    let sourceDeleted = true;
    try { await deleteLocalDocument(invoice.fileKey); } catch { sourceDeleted = false; }
    if (invoice.fileUrl) URL.revokeObjectURL(invoice.fileUrl);
    recordAction(invoice, 'Deleted record', sourceDeleted ? 'Record and source file removed from this browser.' : 'Record removed; source-file cleanup failed in browser storage.');
    setInvoices(previous => previous.filter(row => row.id !== invoice.id));
    if (activeId === invoice.id) setActiveId('');
    notify(sourceDeleted ? 'Record deleted from this browser.' : 'Record removed, but the browser could not remove its source file copy.', sourceDeleted ? 'success' : 'error');
  };

  const confirmInvoice = invoice => {
    if (invoice.direction === 'purchase') { notify('Purchase bills stay outside the GSTR-1 draft. Their ITC eligibility is unverified.', 'error'); return false; }
    if (invoice.validationAuthority === 'backend'
      && (invoice.backendValidationStale
        || invoice.backendValidation?.status !== 'validated'
        || invoice.backendValidation.export_ready !== true)) {
      notify('This invoice cannot be confirmed until the backend returns a current, export-ready validation result.', 'error');
      return false;
    }
    const currentChecks = invoiceFindings(invoice, profile, invoices);
    const blockers = currentChecks.filter(check => check.severity === 'error');
    if (blockers.length) { notify(`Resolve ${blockers.length} blocking check${blockers.length === 1 ? '' : 's'} before confirming.`, 'error'); return false; }
    const warnings = currentChecks.filter(check => check.severity === 'warning').map(check => check.label);
    const confirmed = { ...invoice, confirmed: true, status: invoice.validationAuthority === 'backend' ? invoice.status : 'ready', issues: [], lastConfirmedAt: new Date().toISOString(), confirmedWarnings: warnings };
    updateInvoice(invoice.id, confirmed);
    recordAction(invoice, 'Confirmed by owner', warnings.length ? `Confirmed with acknowledged advisory: ${warnings.join(', ')}` : 'All blocking checks passed.');
    setActiveId('');
    notify(invoice.validationAuthority === 'backend'
      ? 'Owner confirmation saved locally. Backend record is unchanged.'
      : 'Confirmed. This record is included in the review draft.');
    return true;
  };
  const saveForLater = invoice => {
    const findings = invoiceFindings(invoice, profile, invoices);
    const status = invoice.validationAuthority === 'backend' ? invoice.status : deriveInvoiceStatus(findings, false);
    const issues = invoice.validationAuthority === 'backend'
      ? invoice.issues
      : findings.filter(item => ['error','warning'].includes(item.severity)).map(item => item.label);
    updateInvoice(invoice.id, { ...invoice, status, issues, findings });
    const backendProcessed = Boolean(invoice.backendInvoiceId || invoice.backendDocumentId);
    recordAction(invoice, 'Saved for later', backendProcessed
      ? 'Local review draft saved; backend record is unchanged.'
      : 'Edits saved; record remains outside the draft until confirmed.');
    setActiveId('');
    notify(backendProcessed
      ? 'Review draft saved locally. Backend record is unchanged.'
      : 'Saved. You can continue this review later.');
  };
  const escalateInvoice = invoice => {
    const issues = invoiceFindings(invoice, profile, invoices).filter(item => item.severity === 'error' || item.severity === 'warning').map(item => item.label);
    updateInvoice(invoice.id, { ...invoice, status: 'review', escalated: true, issues, escalatedAt: new Date().toISOString() });
    recordAction(invoice, 'Escalated for CA review', issues.join(', ') || 'Owner requests a second review.');
    setActiveId('');
    goTo('ca');
    notify('Added to the CA review queue. Download the CA pack to share it securely.');
  };
  const applySuggestedFix = (invoice, finding) => {
    const ruleId = finding.ruleId || finding.id.split('-')[0];
    const patch = ruleId === 'R01' && finding.field === 'gstin' && gstinChecksumValid(finding.suggestedFix) ? { gstin: finding.suggestedFix } : ruleId === 'R03' ? { totalWritten: Number(invoice.amount || 0) + Number(invoice.tax || 0) } : ruleId === 'R10' ? { bucket: finding.suggestedFix } : null;
    if (!patch) { notify('Check the source bill before applying this correction.', 'error'); return; }
    const corrected = { ...invoice, ...patch, status: 'review', confirmed: false };
    updateInvoice(invoice.id, corrected);
    recordAction(invoice, 'Applied suggested correction', `${finding.label}: ${Object.values(patch).join(', ')}`);
    notify('Suggestion applied. Review the updated value before confirming.');
  };

  const runDemo = () => {
    if (!preferences.replay) { notify('Turn on Guided demo replay in Settings to load synthetic demo scenarios.', 'error'); return; }
    const replay = { ...demoInvoice(), supplier: profile.name, supplierGstin: profile.gstin, supplierStateCode: profile.gstin.slice(0,2), supplierAddress: profile.address };
    const existing = invoices.find(item => item.no === replay.no && item.source === replay.source);
    if (existing) { setActiveId(existing.id); setView('invoices'); notify('Demo replay is open. Try the GSTIN fix and total check.'); return; }
    setInvoices(previous => [replay, ...previous]);
    setActiveId(replay.id); setView('invoices');
    recordAction(replay, 'Started offline replay', 'Synthetic invoice with GSTIN typo, ₹600 total mismatch and rate advisory.');
    notify('Synthetic replay ready. No real business data was used.');
  };
  const runInjectionDemo = () => {
    if (!preferences.replay) { notify('Turn on Guided demo replay in Settings to test the safety check.', 'error'); return; }
    const replay = { ...demoInjectionInvoice(), supplier: profile.name, supplierGstin: profile.gstin, supplierStateCode: profile.gstin.slice(0,2), supplierAddress: profile.address };
    const existing = invoices.find(item => item.no === replay.no && item.source === replay.source);
    if (existing) { setActiveId(existing.id); setView('invoices'); notify('Security replay opened. R12 should quarantine its embedded instruction.'); return; }
    setInvoices(previous => [replay, ...previous]); setActiveId(replay.id); setView('invoices');
    recordAction(replay, 'Ran document safety replay', 'Synthetic instruction-like text was treated as untrusted bill content and quarantined.');
    notify('Safety replay ready. The embedded text cannot change totals or approve a bill.');
  };
  const downloadBackendExports = async (records, format) => {
    let downloaded = 0;
    const errors = [];
    for (const invoice of records) {
      if (!invoice.backendInvoiceId) {
        errors.push(`${invoice.no}: no backend invoice ID is available.`);
        continue;
      }
      try {
        const artifact = format === 'json'
          ? await exportInvoiceJson(invoice.backendInvoiceId)
          : await exportInvoiceCsv(invoice.backendInvoiceId);
        downloadBlob(artifact.blob, artifact.filename || backendExportFilename(invoice, format));
        downloaded += 1;
      } catch (error) {
        const detail = error instanceof ApiError && error.detail ? ` ${error.detail}` : '';
        errors.push(`${invoice.no}: ${error.message || 'Backend export failed.'}${detail}`);
      }
    }
    return { downloaded, errors };
  };
  const exportDraft = async () => {
    const periodInvoices = invoices.filter(item => invoiceInPeriod(item, profile.period));
    const backendRecords = periodInvoices.filter(item => item.direction !== 'purchase' && item.validationAuthority === 'backend');
    const localPeriodInvoices = periodInvoices.filter(item => item.validationAuthority !== 'backend');
    const localEligible = localPeriodInvoices.filter(item => item.direction !== 'purchase' && item.status === 'ready' && item.confirmed);
    if (!localEligible.length && !backendRecords.length) { notify(`Confirm at least one sales record dated in ${profile.period} before creating the draft.`, 'error'); goTo('attention'); return; }
    const backendResult = await downloadBackendExports(backendRecords, 'json');
    let localDownloaded = false;
    if (localEligible.length) {
      const draft = makeGstr1Draft(localPeriodInvoices, profile, profile.period);
      const filename = `GSTR1_Draft_${draft.fp}_${profile.gstin || 'GSTIN'}.json`;
      downloadText(JSON.stringify(draft, null, 2), 'application/json', filename);
      localDownloaded = true;
      recordAction(null, 'Generated GSTR-1 draft', `${localEligible.length} confirmed offline/manual outward sales record(s).`);
    }
    if (backendResult.downloaded) {
      recordAction(null, 'Downloaded backend GSTR-1 exports', `${backendResult.downloaded} invoice JSON export(s).`);
    }
    if (backendResult.errors.length) {
      const failure = backendResult.errors.slice(0, 3).join(' ');
      notify(`${backendResult.downloaded + Number(localDownloaded)} export file(s) downloaded; backend export failed: ${failure}`, 'error');
    } else if (backendResult.downloaded && localDownloaded) {
      notify(`${backendResult.downloaded} backend JSON export(s) and the offline/manual draft were downloaded.`);
    } else if (backendResult.downloaded) {
      notify(`${backendResult.downloaded} backend JSON export(s) downloaded.`);
    } else {
      notify(`Draft downloaded with ${localEligible.length} confirmed offline/manual outward records. Validate it in the official utility.`);
    }
  };
  const exportWorkbook = async () => {
    const buffer = await makeCAWorkbook(invoices, profile, audit);
    downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `BillSetu_CA_Review_${profile.period.replace(/\s+/g,'_')}.xlsx`);
    recordAction(null, 'Generated CA review pack', `${invoices.length} record(s), activity log included.`);
    notify('CA review workbook downloaded. Purchase bills are clearly marked ITC unverified.');
  };
  const exportCSV = async () => {
    const backendRecords = invoices.filter(item => item.validationAuthority === 'backend');
    const localInvoices = invoices.filter(item => item.validationAuthority !== 'backend');
    const backendResult = await downloadBackendExports(backendRecords, 'csv');
    const columns = ['invoice_no','date','buyer','buyer_gstin','taxable_value','cgst','sgst','igst','cess','tax','invoice_total','place_of_supply','return_bucket','status','source','review_notes'];
    const esc = value => { let text = String(value ?? ''); if (/^[=+@\-]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"','""')}"`; };
    let localDownloaded = false;
    if (localInvoices.length || !backendRecords.length) {
      const rows = localInvoices.map(invoice => [invoice.no, invoice.isoDate || invoice.date, invoice.party, invoice.gstin, invoice.amount, invoice.cgst, invoice.sgst, invoice.igst, invoice.cess, invoice.tax, invoice.totalWritten, invoice.pos, invoice.bucket, invoice.status, invoice.source, invoice.issues.join('; ')]);
      downloadText(`\uFEFF${[columns, ...rows].map(row => row.map(esc).join(',')).join('\r\n')}`, 'text/csv;charset=utf-8', 'BillSetu_records.csv');
      localDownloaded = true;
    }
    if (backendResult.downloaded || localDownloaded) {
      recordAction(null, 'Exported records CSV', `${backendResult.downloaded} backend invoice export(s); ${localInvoices.length} offline/manual record(s).`);
    }
    if (backendResult.errors.length) {
      const failure = backendResult.errors.slice(0, 3).join(' ');
      notify(`${backendResult.downloaded + Number(localDownloaded)} export file(s) downloaded; backend export failed: ${failure}`, 'error');
    } else {
      const offlineCount = localDownloaded ? localInvoices.length : 0;
      notify(`${backendResult.downloaded} backend CSV export(s) and ${offlineCount} offline/manual record export(s) downloaded.`);
    }
  };
  const saveProfile = () => {
    const gstin = String(profileDraft.gstin || '').trim().toUpperCase();
    if (!String(profileDraft.name || '').trim() || !String(profileDraft.address || '').trim()) { notify('Add a business name and registered address before saving.', 'error'); return; }
    if (!gstinChecksumValid(gstin)) { notify('Enter a structurally valid 15-character GSTIN before saving.', 'error'); return; }
    const state = STATE_CODES[gstin.slice(0, 2)];
    const next = { ...profileDraft, gstin, state, hsnDigits: profileDraft.turnover === 'over-5cr' ? 6 : 4 };
    setProfile(next); setProfileDraft(next); setProfileEditing(false);
    if (next.period !== profile.period) setInvoices(previous => previous.map(item => {
      if (item.direction === 'purchase' || item.validationAuthority === 'backend') return item;
      const findings = runGSTChecks(item, next, previous);
      if (invoiceInPeriod(item, next.period) && item.confirmed && item.status === 'ready') return item;
      return { ...item, confirmed: false, status: deriveInvoiceStatus(findings, false), issues: findings.filter(finding => ['error', 'warning'].includes(finding.severity)).map(finding => finding.label) };
    }));
    recordAction(null, 'Updated business profile', `GSTIN state code ${gstin.slice(0,2)} · ${next.scheme} scheme.`);
    notify('Business profile saved locally.');
  };
  const resetWorkspace = async () => {
    if (!window.confirm('Reset this browser workspace to the synthetic sample records? Uploaded records and business settings will be removed.')) return;
    invoices.forEach(item => { if (item.fileUrl) URL.revokeObjectURL(item.fileUrl); });
    await Promise.allSettled(invoices.map(item => deleteLocalDocument(item.fileKey)));
    clearLocalWorkspace();
    setInvoices(DEMO_INVOICES); setProfile(PROFILE_SEED); setProfileDraft(PROFILE_SEED); setAudit([]); setView('overview'); setActiveId('');
    notify('Synthetic sample workspace restored.');
  };
  const copyCAInvite = async () => {
    const pending = invoices.filter(item => item.status !== 'ready' && item.direction !== 'purchase').length;
    const inviteText = `BillSetu CA review for ${profile.name}: ${pending} sales record(s) need attention. Review the attached CA pack. This is a local prototype workspace.`;
    try { await navigator.clipboard.writeText(inviteText); notify('Review note copied. Attach the CA Review Pack from Exports.'); }
    catch { downloadText(inviteText, 'text/plain', 'BillSetu_CA_invite_note.txt'); notify('Review note downloaded. Attach the CA Review Pack from Exports.'); }
  };
  const visibleRules = RULES.filter(rule => `${rule[0]} ${rule[1]} ${rule[2]}`.toLowerCase().includes(ruleQuery.toLowerCase()));

  return <div className="app-v2">
    <aside className="side-v2">
      <button className="brand-v2" onClick={() => goTo('overview')} aria-label="BillSetu overview"><span className="brand-mark-v2"><ReceiptText size={19}/></span><span><b>billsetu<span>.</span></b><small>GST, made simpler</small></span></button>
      <button className="workspace-chip" onClick={()=>goTo('settings')}><div className="workspace-avatar">{profile.name.slice(0,1).toUpperCase()}</div><span><b>{profile.name}</b><small>{profile.gstin}</small></span><ChevronDown size={15}/></button>
      <div className="side-label">WORKSPACE</div>
      <nav className="nav-v2" aria-label="Main navigation">
        {[["overview",LayoutDashboard],["invoices",ReceiptText],["attention",CircleAlert],["reports",FileSpreadsheet]].map(([key,Icon])=><button key={key} className={view===key?'selected':''} onClick={()=>goTo(key)}><Icon size={18}/><span>{labels[key]}</span>{key==='invoices'&&<i>{invoices.length}</i>}{key==='attention'&&<i className="nav-alert-count">{issueCount}</i>}</button>)}
      </nav>
      <div className="side-label tools-label-v2">TOOLS</div>
      <nav className="nav-v2">{[["rules",BookOpenCheck],["ca",Globe2],["help",CircleHelp]].map(([key,Icon])=><button key={key} className={view===key?'selected':''} onClick={()=>goTo(key)}><Icon size={18}/><span>{labels[key]}</span></button>)}</nav>
      <div className="side-grow"/>
      <div className="privacy-card-v2"><LockKeyhole size={16}/><div><b>Saved on this device</b><small>Your records stay in this browser in Offline Replay mode.</small></div><span className="local-dot"/></div>
      <button className="profile-v2" onClick={()=>goTo('settings')}><Avatar/> <span><b>Business owner</b><small>Workspace settings</small></span><MoreHorizontal size={18}/></button>
    </aside>

    <main className="main-v2">
      <header className="top-v2"><div className="breadcrumbs"><span>{profile.name}</span><b>/</b><strong>{labels[view] || labels.overview}</strong></div><div className="top-controls"><label className="search-v2"><Search size={17}/><input ref={searchInput} value={query} placeholder={preferences.language==='hi'?'बिल खोजें…':'Search bills or customers'} onChange={event=>{setQuery(event.target.value);if(event.target.value) setView('invoices');}}/><kbd>Ctrl K</kbd></label><button className="icon-v2" title="Open records needing review" onClick={()=>goTo('attention')}><Bell size={18}/>{issueCount>0&&<i/>}</button><button className="language-v2" onClick={()=>setPreferences(prev=>({...prev,language:prev.language==='en'?'hi':'en'}))}><Languages size={16}/>{preferences.language==='en'?'हिंदी':'EN'}</button><button className="user-chip" onClick={()=>goTo('settings')}><Avatar/><span>{profile.name.split(' ')[0]}</span><ChevronDown size={14}/></button></div></header>

      <div className="content-v2">
        {scanProgress&&<div className="processing-banner"><Sparkles size={17}/><div><b>{scanProgress.phase}</b><span>{scanProgress.name}</span></div><div className="processing-track"><i style={{width:`${scanProgress.percent}%`}}/></div><strong>{scanProgress.percent}%</strong></div>}
        {scanError&&<div className="error-banner"><CircleAlert size={16}/><span>{scanError}</span><button onClick={()=>setScanError('')}><X size={15}/></button></div>}

        {view==='overview'&&<Overview invoices={invoices} profile={profile} readiness={readiness} readyCount={readyCount} issueCount={issueCount} totalSales={totalSales} openInvoice={openInvoice} goTo={goTo} onUpload={()=>fileInput.current?.click()} onFiles={processFiles} onPeriod={changeFilingPeriod} runDemo={runDemo} audit={audit}/>} 
        {(view==='invoices'||view==='attention')&&<RecordsView invoices={visibleInvoices} allInvoices={invoices} filter={filter} setFilter={setFilter} view={view} openInvoice={openInvoice} onDelete={deleteInvoice} onUpload={()=>fileInput.current?.click()} onManual={()=>setManualOpen(true)} profile={profile} readiness={readiness}/>}
        {view==='reports'&&<ReportsView invoices={invoices} profile={profile} issueCount={issueCount} readyCount={readyCount} exportDraft={exportDraft} exportWorkbook={exportWorkbook} exportCSV={exportCSV} openInvoice={openInvoice} goTo={goTo}/>}
        {view==='rules'&&<RulesView query={ruleQuery} setQuery={setRuleQuery} rules={visibleRules} goTo={goTo}/>}
        {view==='ca'&&<CAView invoices={invoices} profile={profile} audit={audit} copyInvite={copyCAInvite} exportWorkbook={exportWorkbook} openInvoice={openInvoice} goTo={goTo}/>}
        {view==='help'&&<HelpView goTo={goTo} runDemo={runDemo} runInjectionDemo={runInjectionDemo}/>}
        {view==='settings'&&<SettingsView profile={profile} draft={profileDraft} setDraft={setProfileDraft} editing={profileEditing} setEditing={setProfileEditing} saveProfile={saveProfile} preferences={preferences} setPreferences={setPreferences} resetWorkspace={resetWorkspace} audit={audit}/>}
      </div>
      <footer className="footer-v2"><span>© 2026 BillSetu</span><span>Local preparation workspace · Nothing is filed automatically</span><button onClick={()=>goTo('help')}>How it works</button><b className="offline-tag"><span/> {backendState==='connected'?'BACKEND CONNECTED':backendState==='checking'?'CHECKING BACKEND':'OFFLINE REPLAY'}</b></footer>
      <input ref={fileInput} type="file" className="hidden-input" accept="image/jpeg,image/png,image/webp,application/pdf,.csv,.xlsx" multiple onChange={handleFileChange}/>
    </main>

    {activeInvoice&&<ReviewModal invoice={activeInvoice} profile={profile} invoices={invoices} findings={checks} language={preferences.language} onClose={()=>setActiveId('')} onSave={saveForLater} onConfirm={()=>confirmInvoice(activeInvoice)} onEscalate={()=>escalateInvoice(activeInvoice)} onApply={finding=>applySuggestedFix(activeInvoice,finding)} onUpdate={patch=>updateInvoice(activeInvoice.id,patch)} onAudit={(action,details)=>recordAction(activeInvoice,action,details)}/>}
    {manualOpen&&<ManualEntry onClose={()=>setManualOpen(false)} onSave={invoice=>{const enriched={...invoice,supplier:profile.name,supplierGstin:profile.gstin,supplierStateCode:profile.gstin.slice(0,2),supplierAddress:profile.address,bucket:getBucket(invoice,profile)};const findings=runGSTChecks(enriched,profile,invoices);enriched.findings=findings;enriched.status=deriveInvoiceStatus(findings,false);enriched.issues=findings.filter(item=>['error','warning'].includes(item.severity)).map(item=>item.label);setInvoices(prev=>[enriched,...prev]);setManualOpen(false);setActiveId(enriched.id);setView('invoices');recordAction(enriched,'Created manual record','Entered using the guided form.');notify('Bill added. Review checks before confirming.');}}/>}
    {notice&&<div className={`toast-v2 ${notice.startsWith('error|')?'error':''}`} role="status"><CheckCircle2 size={18}/><span>{notice.split('|').slice(1).join('|')}</span><button onClick={()=>setNotice('')}><X size={15}/></button></div>}
  </div>;
}

function Overview({ invoices, profile, readiness, readyCount, issueCount, totalSales, openInvoice, goTo, onUpload, onFiles, onPeriod, runDemo, audit }) {
  const recent = invoices.filter(item=>item.direction!=='purchase').slice(0,5);
  return <>
    <div className="welcome-v2"><div><span className="eyebrow-v2"><i/> YOUR {profile.period.toUpperCase()} WORKSPACE</span><h1>GST prep, without the guesswork.</h1><p>Bring in your bills. BillSetu checks the details. You decide what goes into the draft.</p></div><div className="welcome-actions"><label className="period-v2"><CalendarDays size={16}/><select aria-label="Filing period" value={profile.period} onChange={event=>onPeriod(event.target.value)}><option>November 2026</option><option>October 2026</option><option>September 2026</option><option>August 2026</option><option>July 2026</option><option>June 2026</option></select><ChevronDown size={14}/></label><button className="button-v2 primary-v2" onClick={()=>goTo('reports')}><ArrowDownToLine size={16}/> Prepare draft</button></div></div>
    <section className="hero-v2"><div className="hero-copy-v2"><span className="eyebrow-v2">PRE-FILING CHECKUP · {profile.period.toUpperCase()}</span><h2>{issueCount ? 'A little review now.' : 'Your records are in good shape.'}<br/><em>A smoother filing later.</em></h2><p>{issueCount ? `${issueCount} record${issueCount===1?'':'s'} need a closer look before they can be included in a draft.` : 'Every confirmed outward record is ready for the next review step.'}</p><div className="hero-actions-v2"><button className="button-v2 light-v2" onClick={()=>goTo('attention')}>{issueCount?`Review ${issueCount} record${issueCount===1?'':'s'}`:'Review all records'} <ArrowRight size={15}/></button><button className="text-button-v2" onClick={runDemo}><Sparkles size={15}/> Run 30-second demo</button></div><div className="privacy-note-v2"><LockKeyhole size={13}/> Your documents are processed on this device in replay mode.</div></div><div className="readiness-card-v2"><span>DATA READINESS</span><div className="readiness-number-v2">{readiness}<small>%</small></div><div className="readiness-bar-v2"><i style={{width:`${readiness}%`}}/></div><small>Based on {invoices.filter(item=>item.direction!=='purchase').length} outward records</small><div className="readiness-legend-v2"><span><i className="green-dot-v2"/>{readyCount} confirmed</span><span><i className="amber-dot-v2"/>{issueCount} to review</span></div></div><div className="hero-spark-v2" aria-hidden="true">✦</div></section>
    <section className="journey-v2"><div className="section-heading-v2"><div><span className="eyebrow-v2">HOW BILLSETU WORKS</span><h3>From a paper bill to a reviewable draft</h3></div><button className="text-button-v2" onClick={()=>goTo('help')}>See the steps <ArrowRight size={14}/></button></div><div className="journey-steps-v2">{[['1','Bring bills','Photos, PDFs or register',CloudUpload,()=>onUpload()],['2','Read & organize','Local OCR or spreadsheet import',FileText,()=>goTo('invoices')],['3','Check & fix','12 explainable rule checks',ShieldCheck,()=>goTo('attention')],['4','You confirm','Owner or CA review',CheckCheck,()=>goTo('attention')],['5','Prepare draft','JSON + CA review pack',FileDown,()=>goTo('reports')]].map(([n,title,sub,Icon,action])=><button key={n} onClick={action} className="journey-step-v2"><span className="journey-icon-v2"><Icon size={18}/></span><span className="journey-number-v2">STEP {n}</span><b>{title}</b><small>{sub}</small></button>)}</div></section>
    <section className="stat-grid-v2"><StatCard icon={Activity} label="Taxable sales captured" value={money(totalSales)} note={`${invoices.filter(item=>item.direction!=='purchase').length} outward records`}/><StatCard icon={CircleAlert} label="Need your attention" value={issueCount} note={issueCount?'Review before export':'Nothing waiting'} tone="amber" action={()=>goTo('attention')}/><StatCard icon={ReceiptText} label="Bills in workspace" value={invoices.length} note={`${readyCount} confirmed for draft`}/><StatCard icon={Zap} label="Records handled" value={audit.filter(item=>item.action.includes('Import')).length+invoices.filter(item=>item.confirmed).length} note="Time back from manual re-entry"/></section>
    <div className="dashboard-grid-v2"><section className="panel-v2 upload-panel-v2"><div className="panel-title-v2"><div><span className="panel-icon-v2"><CloudUpload size={19}/></span><div><h3>Add this month’s bills</h3><p>Photos, PDFs, CSV or Excel sales register. Up to 5 files per batch.</p></div></div><button className="icon-v2" title="Open help for uploads" onClick={()=>goTo('help')}><HelpCircle size={17}/></button></div><button className="dropzone-v2" onClick={onUpload} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const files=event.dataTransfer.files;if(files.length)onFiles(files);}}><span className="upload-symbol-v2"><Upload size={21}/></span><b>Choose bills or drop them here</b><small>JPG, PNG, WebP, searchable/scanned PDF, CSV, XLSX · 10 MB each</small><span className="button-v2 primary-v2 small-v2"><Plus size={15}/> Choose files</span></button><p className="panel-footnote-v2"><LockKeyhole size={13}/> Files stay in this browser. Scanned-image OCR downloads the English model on first use.</p><a className="text-button-v2 sample-link-v2" href="/sample-sales-register.csv" download><Download size={14}/> Download sample register</a></section>
      <section className="panel-v2 quick-panel-v2"><div className="panel-title-v2"><div><span className="panel-icon-v2 mint-v2"><Gauge size={19}/></span><div><h3>Your next steps</h3><p>Keep the month moving with three small steps.</p></div></div></div><div className="next-step-v2" onClick={()=>goTo('attention')} role="button" tabIndex={0} onKeyDown={event=>event.key==='Enter'&&goTo('attention')}><span className={issueCount?'step-state-v2 pending-v2':'step-state-v2 complete-v2'}>{issueCount?<CircleAlert size={16}/>:<Check size={16}/>}</span><span><b>{issueCount?`Review ${issueCount} flagged records`:'Review queue is clear'}</b><small>{issueCount?'Fix errors or record a CA escalation.':'All outward records are confirmed.'}</small></span><ArrowRight size={16}/></div><div className="next-step-v2" onClick={()=>goTo('rules')} role="button" tabIndex={0} onKeyDown={event=>event.key==='Enter'&&goTo('rules')}><span className="step-state-v2 neutral-v2"><BookOpenCheck size={16}/></span><span><b>Understand the checks</b><small>See what BillSetu can and cannot verify.</small></span><ArrowRight size={16}/></div><div className="next-step-v2" onClick={()=>goTo('reports')} role="button" tabIndex={0} onKeyDown={event=>event.key==='Enter'&&goTo('reports')}><span className="step-state-v2 neutral-v2"><FileDown size={16}/></span><span><b>Prepare your CA pack</b><small>{readyCount} confirmed sales record{readyCount===1?'':'s'} ready.</small></span><ArrowRight size={16}/></div></section></div>
    <RecordsTable invoices={recent} title="Recent records" subtitle="A quick look at what is ready and what needs you" onOpen={openInvoice} onAll={()=>goTo('invoices')}/>
    <section className="audit-teaser-v2"><div><History size={17}/><span><b>Recent activity</b><small>{audit.slice(0,2).map(entry=>entry.action).join(' · ')||'Your review history appears here.'}</small></span></div><button onClick={()=>goTo('settings')}>View activity <ArrowRight size={14}/></button></section>
  </>;
}

function StatCard({ icon:Icon,label,value,note,tone,action }) { return <article className="stat-card-v2" onClick={action}><span className={`stat-icon-v2 ${tone||''}`}><Icon size={17}/></span><span className="stat-label-v2">{label}</span><b className="stat-value-v2">{value}</b><small>{note}</small></article>; }

function RecordsView({ invoices, allInvoices, filter, setFilter, view, openInvoice, onDelete, onUpload, onManual, profile, readiness }) {
  return <section className="page-v2"><div className="page-intro-v2"><div><span className="eyebrow-v2">{view==='attention'?'OWNER REVIEW QUEUE':profile.period.toUpperCase()}</span><h1>{view==='attention'?'Let’s clear the loose ends.':'Every bill, in one place.'}</h1><p>{view==='attention'?'Each record explains what needs attention. Nothing is included in the draft until you confirm it.':'Search, review, filter, and organize this period’s sales and purchase bills.'}</p></div><div className="button-row-v2"><button className="button-v2 secondary-v2" onClick={onManual}><Plus size={16}/> Enter a bill</button><button className="button-v2 primary-v2" onClick={onUpload}><Upload size={16}/> Add files</button></div></div><div className="summary-strip-v2"><div><b>{allInvoices.length}</b><small>Total records</small></div><div><b>{allInvoices.filter(item=>item.status==='ready'&&item.direction!=='purchase').length}</b><small>Confirmed sales</small></div><div><b>{allInvoices.filter(item=>item.status!=='ready'&&item.direction!=='purchase').length}</b><small>To review</small></div><div><b>{money(allInvoices.filter(item=>item.direction!=='purchase').reduce((sum,item)=>sum+Number(item.amount||0),0))}</b><small>Taxable captured</small></div><div><b>{readiness}%</b><small>Readiness</small></div></div><section className="panel-v2 table-panel-v2"><div className="filter-toolbar-v2"><div className="filter-pills-v2">{[['all','All',allInvoices.length],['attention','Needs attention',allInvoices.filter(item=>item.status!=='ready'&&item.direction!=='purchase').length],['ready','Confirmed',allInvoices.filter(item=>item.status==='ready').length],['purchase','Purchases',allInvoices.filter(item=>item.direction==='purchase').length]].map(([key,label,count])=><button key={key} className={filter===key?'active':''} onClick={()=>setFilter(key)}>{label}<i>{count}</i></button>)}</div><span><ListFilter size={15}/> {invoices.length} shown</span></div><InvoiceTable invoices={invoices} openInvoice={openInvoice} onDelete={onDelete}/>{!invoices.length&&<div className="empty-v2"><Search size={25}/><b>No bills match this view</b><span>Try another filter, or add a new bill.</span></div>}</section></section>;
}

function RecordsTable({ invoices, title, subtitle, onOpen, onAll }) { return <section className="panel-v2 records-panel-v2"><div className="panel-title-v2"><div><div><h3>{title}</h3><p>{subtitle}</p></div></div><button className="text-button-v2" onClick={onAll}>See all <ArrowRight size={14}/></button></div><InvoiceTable invoices={invoices} openInvoice={onOpen}/></section>; }

function InvoiceTable({ invoices, openInvoice, onDelete }) {
  return <div className="table-wrap-v2"><table className="table-v2"><thead><tr><th>Bill</th><th>Customer</th><th>Taxable value</th><th>Return type</th><th>Status</th><th>Action</th></tr></thead><tbody>{invoices.map(invoice=><tr key={invoice.id}><td><button className="invoice-link-v2" onClick={()=>openInvoice(invoice)}><span className="table-file-v2"><FileText size={16}/></span><span><b>{invoice.no}</b><small>{fmtDate(invoice.isoDate||invoice.date)} · {invoice.source}</small></span></button></td><td><b className="table-party-v2">{invoice.party}</b><small className="table-gstin-v2">{invoice.gstin}</small></td><td><b>{money(invoice.amount)}</b></td><td><span className={`bucket-v2 ${String(invoice.bucket).toLowerCase()}`}>{invoice.direction==='purchase'?'Purchase':invoice.bucket||'Review'}</span></td><td><span className={`status-v2 ${invoice.status}`}><i/>{statusName(invoice.status)}</span></td><td><div className="table-actions-v2"><button className="open-record-v2" onClick={()=>openInvoice(invoice)}>Review <ArrowRight size={14}/></button>{onDelete&&<button className="delete-record-v2" aria-label={`Delete ${invoice.no}`} title="Delete record" onClick={()=>onDelete(invoice)}><Trash2 size={15}/></button>}</div></td></tr>)}</tbody></table>{!invoices.length&&<div className="empty-v2"><b>No records yet</b><span>Upload a bill or import a sales register to get started.</span></div>}</div>;
}

function ReportsView({ invoices, profile, issueCount, readyCount, exportDraft, exportWorkbook, exportCSV, openInvoice, goTo }) {
  const ready = invoices.filter(item=>item.validationAuthority!=='backend'&&item.status==='ready'&&item.confirmed&&item.direction!=='purchase');
  const backendRecords = invoices.filter(item => item.validationAuthority === 'backend' && item.backendValidation);
  return <section className="page-v2">
    <div className="page-intro-v2"><div><span className="eyebrow-v2">YOUR RECORDS, YOUR WAY</span><h1>Prepare a reviewable draft.</h1><p>Local drafts use browser-saved records. Backend-processed invoices export from the backend; local review corrections are not included.</p></div></div>
    <BackendGstr1Results invoices={backendRecords}/>
    <div className="export-readiness-v2"><span className="export-readiness-icon"><ShieldCheck size={21}/></span><div><b>{readyCount} confirmed outward records · {issueCount} still need review</b><small>Only confirmed sales appear in the GSTR-1 draft. Purchases are separated and ITC is not verified.</small></div><button className="button-v2 secondary-v2" onClick={()=>goTo('attention')} disabled={!issueCount}>Review queue</button></div>
    <div className="exports-grid-v2"><ExportCard icon={FileCheck2} eyebrow="PREPARATION DRAFT" title="GSTR-1 JSON" body={`${ready.length} confirmed outward sales record${ready.length===1?'':'s'} will be grouped into a local draft structure.`} items={['Confirmed sales only','B2B, B2CL and B2CS grouping','No filing or GSTN upload occurs']} button="Download JSON draft" onClick={exportDraft}/><ExportCard icon={FileSpreadsheet} eyebrow="FOR YOUR CA" title="CA review workbook" body="A multi-sheet Excel pack for review, with a separate queue for incomplete records and purchases." items={['All records and review notes','Local activity history included','Purchases marked ITC unverified']} button="Download Excel pack" onClick={exportWorkbook}/><ExportCard icon={ClipboardList} eyebrow="SIMPLE REGISTER" title="CSV record list" body="A lightweight copy of every record for your own working files." items={['All record states included','Formula-like values escaped','UTF-8 Indian currency data']} button="Download CSV" onClick={exportCSV}/></div>
    <div className="legal-note-v2"><ShieldCheck size={18}/><span><b>Review boundary</b><small>The JSON is a prototype preparation draft, not schema-certified against the current official offline utility. Validate it with the official GST utility and your CA before use. BillSetu never files a return or verifies ITC.</small></span></div><RecordsTable invoices={invoices.filter(item=>item.status!=='ready').slice(0,5)} title="Records left out of the draft" subtitle="Resolve or escalate these items to include them." onOpen={openInvoice} onAll={()=>goTo('attention')}/>
  </section>;
}

function BackendGstr1Results({ invoices }) {
  if (!invoices.length) return null;
  return <section className="panel-v2 activity-panel-v2">
    <div className="panel-heading-v2"><div><span className="eyebrow-v2">BACKEND-PROCESSED INVOICES</span><h2>Authoritative backend GSTR-1 results</h2><p>Results are displayed as returned by the backend. The local JSON draft below remains unchanged.</p></div></div>
    <div className="table-wrap-v2"><table className="data-table-v2">
      <thead><tr><th>Invoice</th><th>Result</th><th>Type</th><th>Date</th><th>Taxable value</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Cess</th><th>Grand total</th><th>Lines</th><th>Full response</th></tr></thead>
      <tbody>{invoices.map(invoice => {
        const result = invoice.backendGstr1;
        const status = invoice.backendGstr1Status === 'available' ? 'Available' : invoice.backendGstr1Status === 'unavailable' ? 'Unavailable' : 'Loading';
        return <tr key={invoice.id}>
          <td><b>{invoice.invoiceNumber || result?.invoice_number || 'Invoice'}</b><small>{invoice.supplierGstin || result?.supplier_gstin || ''}</small></td>
          <td>{status}{invoice.backendGstr1Error&&<small>{invoice.backendGstr1Error}</small>}</td>
          {result ? <>
            <td>{result.invoice_type}</td><td>{result.invoice_date}</td>
            <td>{money(result.taxable_value)}</td><td>{money(result.cgst_total)}</td><td>{money(result.sgst_total)}</td><td>{money(result.igst_total)}</td><td>{money(result.cess_total)}</td><td>{money(result.grand_total)}</td>
            <td>{result.line_items.length}</td><td><details><summary>View response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details></td>
          </> : <td colSpan="10">No backend GSTR-1 record is available. The invoice and backend validation result are retained.</td>}
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}
function ExportCard({ icon:Icon,eyebrow,title,body,items,button,onClick }) { return <article className="export-card-v2"><span className="export-icon-v2"><Icon size={22}/></span><span className="eyebrow-v2">{eyebrow}</span><h3>{title}</h3><p>{body}</p><ul>{items.map(item=><li key={item}><Check size={14}/>{item}</li>)}</ul><button className="button-v2 primary-v2" onClick={onClick}><Download size={16}/>{button}</button></article>; }

function RulesView({ query,setQuery,rules,goTo }) { return <section className="page-v2"><div className="page-intro-v2"><div><span className="eyebrow-v2">EXPLAINABLE CHECKS</span><h1>What BillSetu checks—and what it doesn’t.</h1><p>Rules are deterministic and visible. A green result means a structural check passed, not that a return is legally certified.</p></div><button className="button-v2 primary-v2" onClick={()=>goTo('attention')}><ShieldCheck size={16}/> Open review queue</button></div><label className="rule-search-v2"><Search size={17}/><input placeholder="Find a check by name" value={query} onChange={event=>setQuery(event.target.value)}/></label><div className="rules-grid-v2">{rules.map(([id,title,description])=><article className="rule-card-v2" key={id}><span>{id}</span><div><h3>{title}</h3><p>{description}</p></div><BadgeCheck size={18}/></article>)}</div><div className="three-zones-v2"><article><span>1</span><div><b>BillSetu can check</b><p>Field structure, arithmetic, duplicates and consistency signals in the information you enter.</p></div></article><article><span>2</span><div><b>You or your CA must verify</b><p>Live GSTIN status, exact HSN rates, place-of-supply edge cases, RCM and ITC against GSTR-2B/IMS.</p></div></article><article><span>3</span><div><b>BillSetu never claims</b><p>Legal advice, audit certification, guaranteed immunity, or filing returns on the GST portal.</p></div></article></div></section>; }

function CAView({ invoices,profile,audit,copyInvite,exportWorkbook,openInvoice,goTo }) { const pending=invoices.filter(item=>item.status!=='ready'&&item.direction!=='purchase'); const confirmed=invoices.filter(item=>item.status==='ready'&&item.confirmed&&item.direction!=='purchase'); return <section className="page-v2"><div className="page-intro-v2"><div><span className="eyebrow-v2">ACCOUNTANT COLLABORATION</span><h1>A calmer hand-off to your CA.</h1><p>Prepare a review pack and a clear note. Your CA keeps authority over tax classification and filing.</p></div><button className="button-v2 primary-v2" onClick={exportWorkbook}><FileSpreadsheet size={16}/> Build CA pack</button></div><div className="ca-hero-v2"><div className="ca-avatar-v2"><Building2 size={26}/></div><div><span className="eyebrow-v2">THIS CLIENT WORKSPACE</span><h2>{profile.name}</h2><p>{profile.gstin} · {profile.state} · {profile.period}</p></div><button className="button-v2 secondary-v2" onClick={copyInvite}>Copy review note</button></div><div className="ca-stats-v2"><div><b>{pending.length}</b><small>Needs owner or CA review</small></div><div><b>{confirmed.length}</b><small>Owner-confirmed sales</small></div><div><b>{invoices.filter(item=>item.direction==='purchase').length}</b><small>Purchases · ITC unverified</small></div></div><RecordsTable invoices={pending.slice(0,6)} title="Shared review queue" subtitle="Open any bill for its source, checks and correction history." onOpen={openInvoice} onAll={()=>goTo('attention')}/><section className="panel-v2 activity-panel-v2"><div className="panel-title-v2"><div><span className="panel-icon-v2"><History size={18}/></span><div><h3>Workspace activity</h3><p>Locally saved action history for this prototype.</p></div></div></div>{audit.slice(0,6).map(entry=><div className="activity-row-v2" key={entry.id}><span><History size={15}/></span><div><b>{entry.action} · {entry.invoice}</b><small>{entry.details}</small></div><time>{new Date(entry.at).toLocaleString('en-IN')}</time></div>)}{!audit.length&&<div className="empty-v2">No activity recorded yet.</div>}</section><p className="small-note-v2">To share outside this browser, download the CA review pack and send it using your own secure channel. No records are sent automatically.</p></section>; }

function HelpView({ goTo,runDemo,runInjectionDemo }) { const entries=[['How do I begin?','Upload one bill or import a register. We read supported files on this device, then open every record for your review.'],['What does OCR do?','OCR suggests text from a photo. It can misread handwriting. Compare every field with the source and correct it before confirmation.'],['What does “Ready” mean?','Required checks passed and an owner confirmed the record. It does not certify the tax rate, active GSTIN status, ITC or legal position.'],['Can BillSetu file a return?','No. BillSetu prepares a draft and review pack. The registered taxpayer or authorized professional reviews and files through the official GST channel.'],['Are purchase bills ITC eligible?','BillSetu only logs purchase bills. ITC eligibility requires separate verification, including GSTR-2B/IMS and applicable rules.'],['Where is my data saved?','Records and file copies are stored in this browser. Clear site data or use Reset workspace in Settings to remove the local workspace.']]; return <section className="page-v2"><div className="page-intro-v2"><div><span className="eyebrow-v2">PLAIN-LANGUAGE HELP</span><h1>GST prep, one small step at a time.</h1><p>Quick answers for shop owners and the people who help them review.</p></div><div className="button-row-v2"><button className="button-v2 secondary-v2" onClick={runInjectionDemo}><ShieldCheck size={16}/> Test document safety</button><button className="button-v2 primary-v2" onClick={runDemo}><Sparkles size={16}/> Try the sample</button></div></div><div className="help-layout-v2"><div className="faq-list-v2">{entries.map(([question,answer])=><details key={question} open={question==='How do I begin?'}><summary>{question}<ChevronDown size={16}/></summary><p>{answer}</p></details>)}</div><aside className="help-aside-v2"><CircleHelp size={22}/><h3>Need a person?</h3><p>Use the CA workspace to create a review note and workbook for your accountant.</p><button className="button-v2 secondary-v2" onClick={()=>goTo('ca')}>Open CA workspace <ArrowRight size={15}/></button></aside></div></section>; }

function SettingsView({ profile,draft,setDraft,editing,setEditing,saveProfile,preferences,setPreferences,resetWorkspace,audit }) { return <section className="page-v2"><div className="page-intro-v2"><div><span className="eyebrow-v2">BUSINESS PROFILE</span><h1>Your business, your rules.</h1><p>These details help BillSetu organize records and make basic consistency checks.</p></div>{editing?<div className="button-row-v2"><button className="button-v2 secondary-v2" onClick={()=>setEditing(false)}>Cancel</button><button className="button-v2 primary-v2" onClick={saveProfile}><Check size={16}/> Save profile</button></div>:<button className="button-v2 secondary-v2" onClick={()=>{setDraft(profile);setEditing(true);}}>Edit profile</button>}</div><div className="settings-grid-v2"><section className="panel-v2 settings-panel-v2"><div className="settings-business-v2"><span className="settings-logo-v2">{profile.name.slice(0,1)}</span><div><h3>{profile.name}</h3><p>{profile.state} · {profile.scheme==='composition'?'Composition':'Regular'} taxpayer profile</p></div></div><div className="form-grid-v2"><FormField label="Business name" value={editing?draft.name:profile.name} disabled={!editing} onChange={value=>setDraft(prev=>({...prev,name:value}))}/><FormField label="Business GSTIN" value={editing?draft.gstin:profile.gstin} disabled={!editing} onChange={value=>setDraft(prev=>({...prev,gstin:value.toUpperCase()}))}/><FormField label="Registered business address" value={editing?draft.address:profile.address} disabled={!editing} onChange={value=>setDraft(prev=>({...prev,address:value}))}/><label className="form-field-v2"><span>Taxpayer scheme</span><select disabled={!editing} value={editing?draft.scheme:profile.scheme} onChange={event=>setDraft(prev=>({...prev,scheme:event.target.value}))}><option value="regular">Regular</option><option value="composition">Composition</option></select></label><label className="form-field-v2"><span>Annual turnover band</span><select disabled={!editing} value={editing?draft.turnover:profile.turnover} onChange={event=>setDraft(prev=>({...prev,turnover:event.target.value}))}><option value="under-5cr">Up to ₹5 crore</option><option value="over-5cr">Above ₹5 crore</option></select></label><label className="form-field-v2"><span>Filing frequency</span><select disabled={!editing} value={editing?draft.filing:profile.filing} onChange={event=>setDraft(prev=>({...prev,filing:event.target.value}))}><option>Monthly</option><option>Quarterly</option></select></label><label className="form-field-v2"><span>Filing period</span><select disabled={!editing} value={editing?draft.period:profile.period} onChange={event=>setDraft(prev=>({...prev,period:event.target.value}))}><option>November 2026</option><option>October 2026</option><option>September 2026</option><option>August 2026</option><option>July 2026</option><option>June 2026</option></select></label></div><div className="settings-info-v2"><ShieldCheck size={17}/><span>GSTIN structure is checked locally. BillSetu does not verify the GST portal’s active status.</span></div></section><section className="panel-v2 settings-panel-v2"><h3>Preferences & local data</h3><p>Choose how BillSetu behaves on this device.</p><div className="settings-option-v2"><span className="settings-option-icon"><Languages size={18}/></span><div><b>Language</b><small>Navigation labels and review hints</small></div><div className="language-switch-v2"><button className={preferences.language==='en'?'active':''} onClick={()=>setPreferences(prev=>({...prev,language:'en'}))}>English</button><button className={preferences.language==='hi'?'active':''} onClick={()=>setPreferences(prev=>({...prev,language:'hi'}))}>हिंदी</button></div></div><div className="settings-option-v2"><span className="settings-option-icon"><HardDrive size={18}/></span><div><b>Guided demo replay</b><small>{preferences.replay?'Synthetic demo scenarios are available':'Turn on to add synthetic GST review scenarios'}</small></div><button className={`mode-badge-v2 ${preferences.replay?'':'off'}`} aria-pressed={preferences.replay} onClick={()=>setPreferences(prev=>({...prev,replay:!prev.replay}))}>{preferences.replay?'ON':'OFF'}</button></div><div className="settings-option-v2"><span className="settings-option-icon"><LockKeyhole size={18}/></span><div><b>Browser-local storage</b><small>{audit.length} review actions saved on this device</small></div><span className="local-dot"/></div><button className="button-v2 danger-outline-v2" onClick={resetWorkspace}><RotateCcw size={16}/> Reset to sample workspace</button><p className="small-note-v2">Reset deletes local imported records and source files from this browser. Export records first if you need to keep them.</p></section></div><section className="panel-v2 activity-panel-v2"><div className="panel-title-v2"><div><span className="panel-icon-v2"><History size={18}/></span><div><h3>Recent changes</h3><p>Append-only activity history for the local prototype.</p></div></div></div>{audit.slice(0,10).map(entry=><div className="activity-row-v2" key={entry.id}><span><History size={15}/></span><div><b>{entry.action} · {entry.invoice}</b><small>{entry.details}</small></div><time>{new Date(entry.at).toLocaleString('en-IN')}</time></div>)}</section></section>; }
function FormField({label,value,disabled,onChange,type='text'}) { return <label className="form-field-v2"><span>{label}</span><input type={type} value={value??''} disabled={disabled} onChange={event=>onChange(event.target.value)}/></label>; }

function ReviewModal({ invoice,profile,invoices,findings,language,onClose,onSave,onConfirm,onEscalate,onApply,onUpdate,onAudit }) {
  const [tab,setTab]=useState('review');
  const hasBackendRecord=Boolean(invoice.backendInvoiceId||invoice.backendDocumentId);
  const backendSourceMissing=hasBackendRecord&&!invoice.backendDocumentId;
  const [backendAudit,setBackendAudit]=useState({key:'',status:'idle',events:[],error:''});
  const auditRequests=useRef(new Map());
  const requestedAuditKeys=useRef(new Set());
  const backendAuditKey=invoice.backendDocumentId
    ? `document:${invoice.backendDocumentId}`
    : invoice.backendInvoiceId
      ? `invoice:${invoice.backendInvoiceId}`
      : '';
  const visibleBackendAudit=backendAudit.key===backendAuditKey&&backendAuditKey
    ? backendAudit
    : backendAuditKey
      ? {status:'idle',events:[],error:''}
      : {status:'unavailable',events:[],error:'No backend document or invoice identifier is available.'};
  useEffect(()=>{
    if(tab!=='history'||invoice.validationAuthority!=='backend')return;
    if(!backendAuditKey){setBackendAudit({key:'',status:'unavailable',events:[],error:'No backend document or invoice identifier is available.'});return;}
    if(requestedAuditKeys.current.has(backendAuditKey)&&!auditRequests.current.has(backendAuditKey))return;
    let request=auditRequests.current.get(backendAuditKey);
    if(request){return;}
    requestedAuditKeys.current.add(backendAuditKey);
    setBackendAudit({key:backendAuditKey,status:'loading',events:[],error:''});
    request=invoice.backendDocumentId
      ? getDocumentAudit(invoice.backendDocumentId)
      : getInvoiceAudit(invoice.backendInvoiceId);
    auditRequests.current.set(backendAuditKey,request);
    request.then(response=>{
      const events=validateBackendAuditEvents(response);
      setBackendAudit(current=>current.key===backendAuditKey
        ? {key:backendAuditKey,status:'available',events,error:''}
        : current);
    }).catch(error=>{
      const message=error instanceof ApiError&&error.detail
        ? error.detail
        : error.message||'The backend audit request failed.';
      setBackendAudit(current=>current.key===backendAuditKey
        ? {key:backendAuditKey,status:'unavailable',events:[],error:message}
        : current);
    }).then(()=>auditRequests.current.delete(backendAuditKey));
  },[tab,invoice.validationAuthority,invoice.backendDocumentId,invoice.backendInvoiceId,backendAuditKey]);
  const patch = (key,value) => { setAdvisoryAck(false);const next={...invoice,[key]:value,confirmed:false};if(['cgst','sgst','igst','cess'].includes(key))next.taxHeadsCaptured=true;if(['gstin','pos','posStateCode','amount','tax','totalWritten','party','buyerAddress','hsn','no','isoDate','bucket'].includes(key))next.bucket=getBucket(next,profile);onUpdate(next); };
  const repair = suggestGSTINRepairs(invoice.gstin)[0];
  const blockers=findings.filter(item=>item.severity==='error');
  const advisories=findings.filter(item=>item.severity==='warning');
  const allClear=blockers.length===0;
  const [advisoryAck,setAdvisoryAck]=useState(false);
  const backendCanConfirm=invoice.validationAuthority!=='backend'||(!invoice.backendValidationStale&&invoice.backendValidation?.status==='validated'&&invoice.backendValidation.export_ready===true);
  const canConfirm=allClear&&(advisories.length===0||advisoryAck)&&backendCanConfirm;
  const confirmLabel=canConfirm?'Confirm record':invoice.validationAuthority==='backend'&&invoice.backendValidationStale?'Local edits cannot be confirmed':'Resolve blockers / review advisories';
  const applyTotal=()=>{patch('totalWritten',Number(invoice.amount||0)+Number(invoice.tax||0));onAudit('Applied arithmetic suggestion','Grand total set to taxable value plus tax.');};
  return <div className="modal-overlay-v2" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><section className="review-modal-v2" role="dialog" aria-modal="true" aria-labelledby="review-heading"><header className="review-top-v2"><button className="back-button-v2" onClick={onClose}><ArrowLeft size={16}/> Back to records</button><span className="local-pill-v2"><HardDrive size={13}/> {invoice.validationAuthority==='backend'?'BACKEND VALIDATION':'LOCAL REVIEW'}</span><button className="icon-v2" onClick={onClose} aria-label="Close review"><X size={19}/></button></header><div className="review-body-v2"><div className="review-heading-v2"><div><span className="eyebrow-v2">{invoice.kind?.toUpperCase()||'INVOICE'} · {fmtDate(invoice.isoDate||invoice.date)}</span><h2 id="review-heading">{invoice.no}</h2><p>{invoice.source} <span>·</span> {invoice.source === 'Manual entry' ? 'Entered manually' : <>Capture signal: <b className={invoice.confidence<60?'confidence-low-v2':''}>{invoice.confidence ?? 0}%</b></>}</p></div><span className={`status-v2 ${invoice.status}`}><i/>{statusName(invoice.status)}</span></div><div className="review-tabs-v2"><button className={tab==='review'?'active':''} onClick={()=>setTab('review')}>Review & fix <i>{blockers.length+advisories.length}</i></button><button className={tab==='checks'?'active':''} onClick={()=>setTab('checks')}>{invoice.validationAuthority==='backend'?'Backend result':'12 checks'} <i>{invoice.validationAuthority==='backend'?findings.length:`${findings.filter(item=>item.severity==='pass').length}/12`}</i></button><button className={tab==='history'?'active':''} onClick={()=>setTab('history')}>Source & evidence</button></div>
    {tab==='review'&&<div className="review-columns-v2"><aside className="source-pane-v2"><div className="source-heading-v2"><FileText size={17}/><div><b>Original bill</b><small>Compare each extracted value to this source</small></div></div><div className="source-canvas-v2">{invoice.fileUrl?(invoice.sourceMediaType==='application/pdf'||invoice.kind==='PDF invoice'?<iframe src={invoice.fileUrl} title="Uploaded invoice PDF"/>:<img src={invoice.fileUrl} alt="Uploaded invoice"/>):hasBackendRecord?<div role={invoice.sourcePreviewStatus==='unavailable'||backendSourceMissing?'alert':'status'}>{invoice.sourcePreviewStatus==='unavailable'?`Original source unavailable: ${invoice.sourcePreviewError||'The backend document could not be retrieved.'}`:backendSourceMissing?'Original source document is unavailable.':'Loading original source document…'}</div>:<div className="demo-invoice-v2"><div className="demo-invoice-brand">{invoice.supplier||profile.name}<small>TAX INVOICE</small></div><hr/><p>Invoice no. <b>{invoice.no}</b></p><p>Invoice date <b>{fmtDate(invoice.isoDate||invoice.date)}</b></p><p>Buyer GSTIN <b className={gstinChecksumValid(invoice.gstin)?'':'bad-text-v2'}>{invoice.gstin}</b></p><hr/><p>Taxable value <b>{money(invoice.amount)}</b></p><p>Tax <b>{money(invoice.tax)}</b></p><p className="paper-total-v2">Total on bill <b>{money(invoice.totalWritten)}</b></p></div>}</div><p className="source-caption-v2">{invoice.fileUrl?invoice.sourceMediaType?'Source retrieved from backend document storage.':'Uploaded source is shown from local browser storage.':hasBackendRecord?backendSourceMissing?'Original source document is unavailable.':'Source preview uses the backend document reference.':'Synthetic or register-only record. No bill image was supplied.'}</p><button className="source-open-v2" disabled={!invoice.fileUrl} onClick={()=>window.open(invoice.fileUrl,'_blank','noopener,noreferrer')}>Open source in new tab <ArrowRight size={14}/></button></aside>
    <section className="fields-pane-v2"><div className="pane-title-v2"><div><h3>Check the details</h3><p>Correct a field if it does not match the bill.</p>{hasBackendRecord&&<p className="small-note-v2" role="note">Local review draft — backend record is unchanged. Validation, GSTR-1 and exports still use backend data.</p>}</div><span className={`confidence-badge-v2 ${invoice.confidence>=85?'high':invoice.confidence>=60?'medium':'low'}`}>{invoice.source==='Manual entry'?'MANUAL ENTRY':`${invoice.confidence>=85?'HIGH':invoice.confidence>=60?'CHECK':'LOW'} CAPTURE SIGNAL`}</span></div><div className="review-form-v2"><FormField label="Invoice number" value={invoice.no} onChange={value=>patch('no',value)}/><FormField label="Invoice date" type="date" value={invoice.isoDate||''} onChange={value=>patch('isoDate',value)}/><FormField label="Customer / buyer" value={invoice.party} onChange={value=>patch('party',value)}/><div className="form-field-v2"><span>Buyer GSTIN</span><input className={!gstinChecksumValid(invoice.gstin)&&invoice.gstin!=='Unregistered'?'input-error-v2':''} value={invoice.gstin} onChange={event=>patch('gstin',event.target.value.toUpperCase())}/>{repair&&<button className="inline-suggestion-v2" onClick={()=>{patch('gstin',repair);onAudit('Applied GSTIN suggestion',`${invoice.gstin} → ${repair}`);}}><Sparkles size={13}/> Suggested checksum match: {repair} · Use</button>}</div><FormField label="Buyer address (when required)" value={invoice.buyerAddress||''} onChange={value=>patch('buyerAddress',value)}/><label className="form-field-v2"><span>Place of supply</span><select value={invoice.posStateCode||stateCodeFor(invoice.pos)||''} onChange={event=>{setAdvisoryAck(false);const code=event.target.value;onUpdate({...invoice,posStateCode:code,pos:STATE_CODES[code]||'',confirmed:false,bucket:getBucket({...invoice,posStateCode:code,pos:STATE_CODES[code]||''},profile)});}}><option value="">Choose state</option>{Object.entries(STATE_CODES).map(([code,state])=><option key={code} value={code}>{code} · {state}</option>)}</select></label><FormField label="Taxable value (₹)" type="number" value={invoice.amount} onChange={value=>patch('amount',Number(value))}/><FormField label="Total tax (₹)" type="number" value={invoice.tax} onChange={value=>patch('tax',Number(value))}/><FormField label="CGST (₹)" type="number" value={invoice.cgst??''} onChange={value=>patch('cgst',Number(value))}/><FormField label="SGST (₹)" type="number" value={invoice.sgst??''} onChange={value=>patch('sgst',Number(value))}/><FormField label="IGST (₹)" type="number" value={invoice.igst??''} onChange={value=>patch('igst',Number(value))}/><FormField label="Cess (₹)" type="number" value={invoice.cess??''} onChange={value=>patch('cess',Number(value))}/><FormField label="Grand total on bill (₹)" type="number" value={invoice.totalWritten} onChange={value=>patch('totalWritten',Number(value))}/><FormField label="HSN / SAC" value={invoice.hsn||''} onChange={value=>patch('hsn',value)}/></div><div className="math-strip-v2"><span>Expected total <b>{money(Number(invoice.amount||0)+Number(invoice.tax||0))}</b></span><b className={Math.abs(Number(invoice.totalWritten||0)-Number(invoice.amount||0)-Number(invoice.tax||0))>1?'math-error-v2':'math-ok-v2'}>{Math.abs(Number(invoice.totalWritten||0)-Number(invoice.amount||0)-Number(invoice.tax||0))>1?`${money(Math.abs(Number(invoice.totalWritten||0)-Number(invoice.amount||0)-Number(invoice.tax||0)))} difference`:'Total matches'}</b>{Math.abs(Number(invoice.totalWritten||0)-Number(invoice.amount||0)-Number(invoice.tax||0))>1&&<button onClick={applyTotal}>Use calculated total</button>}</div><div className="fix-list-v2"><h4>What needs a look</h4>{findings.filter(item=>item.severity==='error'||item.severity==='warning').map(finding=><div className={`finding-v2 ${finding.severity}`} key={finding.id}><span>{finding.severity==='error'?<CircleAlert size={17}/>:<HelpCircle size={17}/>}</span><div><b>{finding.label}</b><p>{language==='hi'?`${finding.message} इसे बिल/CA से जाँचें।`:finding.message}</p><small>{finding.suggestedFix?`Suggested next step: ${finding.suggestedFix}`:'Verify this with the original bill.'}</small></div>{finding.suggestedFix&&((finding.id==='R01'&&finding.field==='gstin'&&gstinChecksumValid(finding.suggestedFix))||finding.id==='R03'||finding.id==='R10')&&<button onClick={()=>{setAdvisoryAck(false);onApply(finding);}}>Apply</button>}</div>)}{!findings.some(item=>item.severity==='error'||item.severity==='warning')&&<div className="all-clear-v2"><CheckCircle2 size={18}/> No blocking findings. Your confirmation is still required.</div>}</div>{advisories.length>0&&<label className="advisory-ack-v2"><input type="checkbox" checked={advisoryAck} onChange={event=>setAdvisoryAck(event.target.checked)}/><span>I checked the advisory against the bill and accept responsibility for confirming this record.</span></label>}</section></div>}
    {tab==='checks'&&<div className="checks-pane-v2"><div className="checks-summary-v2"><ShieldCheck size={20}/><div><b>{blockers.length?`${blockers.length} blocking item${blockers.length===1?'':'s'}`:advisories.length?`${advisories.length} advisory item${advisories.length===1?'':'s'}`:'No blocking findings'}</b><small>{invoice.validationAuthority==='backend'
      ? invoice.backendValidation
        ? `${invoice.backendValidation.summary.headline}: ${invoice.backendValidation.summary.message}${invoice.backendValidationStale?' The result is for the persisted backend invoice; local edits have not been validated by the backend.':''}`
        : `Authoritative backend validation unavailable: ${invoice.backendValidationError || 'No validation result was returned.'}`
      : 'Checks run in your browser from the fields shown. No AI decides totals or approves a record.'}</small></div></div><div className="checks-grid-v2">{findings.map(item=><article className={`check-card-v2 ${item.severity}`} key={item.id}><span className="check-state-v2">{item.severity==='pass'?<Check size={15}/>:item.severity==='error'?<X size={15}/>:item.severity==='warning'?<CircleAlert size={15}/>:<MoreHorizontal size={15}/>}</span><div><small>{item.id}</small><b>{item.label}</b><p>{item.message}</p></div><i>{item.severity==='pass'?'Passed':item.severity==='error'?'Fix needed':item.severity==='warning'?'Review':'Not applicable / missing data'}</i></article>)}</div></div>}
    {tab==='history'&&<div className="evidence-pane-v2">
      {invoice.validationAuthority==='backend'&&<section>
        <h3>Backend audit history</h3>
        {visibleBackendAudit.status==='idle'||visibleBackendAudit.status==='loading'
          ? <p role="status">Loading backend audit history…</p>
          : visibleBackendAudit.status==='unavailable'
            ? <div className="error-banner" role="alert"><span>Backend audit history is unavailable: {visibleBackendAudit.error} Frontend-local history has not been substituted.</span></div>
            : visibleBackendAudit.events.length
              ? visibleBackendAudit.events.map(event=><div className="activity-row-v2" key={event.event_id}>
                <span><History size={15}/></span>
                <div><b>{event.event_type}</b><small>{event.message}</small><small>Status: {event.status} · Document ID: {event.document_id} · Invoice ID: {String(event.invoice_id)}</small>
                  <details><summary>Full event details</summary><pre>{JSON.stringify(event,null,2)}</pre></details>
                </div>
                <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString('en-IN')}</time>
              </div>)
              : <p>The backend returned no audit events for this record.</p>}
      </section>}
      <h3>Source evidence & limitations</h3><p><b>Original file:</b> {invoice.source}</p><p><b>Capture signal:</b> {invoice.source === 'Manual entry' ? 'Entered manually' : `${invoice.confidence}% OCR clarity estimate; not a calibrated probability.`}</p><p><b>Extracted text:</b></p><pre>{invoice.rawText||'No OCR text is available for this manually entered or synthetic record.'}</pre><p>Text from a document is treated only as data. Instructions printed inside bills are never executed. Any suspicious instruction-like text is quarantined by R12.</p></div>}
    </div><footer className="review-footer-v2"><div className="review-disclaimer-v2"><ShieldCheck size={16}/><span>Draft preparation only · Active GSTIN, legal classification and ITC require separate verification.</span></div><div className="review-footer-actions-v2"><button className="button-v2 secondary-v2" onClick={()=>onSave(invoice)}>Save for later</button><button className="button-v2 secondary-v2" onClick={onEscalate}>Flag for CA</button>{invoice.direction==='purchase'?<span className="purchase-note-v2">Purchase record · ITC unverified · outside GSTR-1</span>:<button className="button-v2 primary-v2" disabled={!canConfirm} onClick={onConfirm}><CheckCheck size={16}/>{confirmLabel}</button>}</div></footer></section></div>;
}

function ManualEntry({ onClose,onSave }) { const [data,setData]=useState({no:'',party:'',gstin:'Unregistered',isoDate:'',amount:'',tax:'',totalWritten:'',posStateCode:'',buyerAddress:'',hsn:'',bucket:'Review'}); const update=(key,value)=>setData(prev=>({...prev,[key]:value})); return <div className="modal-overlay-v2" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><form className="manual-modal-v2" onSubmit={event=>{event.preventDefault();const state=STATE_CODES[data.posStateCode]||'';onSave(makeInvoice({...data,party:data.party||'Buyer to confirm',amount:Number(data.amount)||0,tax:Number(data.tax)||0,totalWritten:Number(data.totalWritten)||Number(data.amount||0)+Number(data.tax||0),pos:state,status:'review',issues:['New manual record — review each field'],confidence:null,isoDate:data.isoDate,date:data.isoDate,source:'Manual entry',kind:'Tax invoice',items:[],cgst:0,sgst:0,igst:0,taxHeadsCaptured:false}));}}><header><span><Plus size={18}/> New bill</span><button type="button" className="icon-v2" onClick={onClose}><X size={18}/></button></header><p>Enter the main details from the source bill. You can correct them in the review step.</p><div className="manual-fields-v2"><FormField label="Invoice number" value={data.no} onChange={value=>update('no',value)}/><FormField label="Invoice date" type="date" value={data.isoDate} onChange={value=>update('isoDate',value)}/><FormField label="Customer / buyer" value={data.party} onChange={value=>update('party',value)}/><FormField label="Buyer GSTIN or Unregistered" value={data.gstin} onChange={value=>update('gstin',value.toUpperCase())}/><FormField label="Taxable value (₹)" type="number" value={data.amount} onChange={value=>update('amount',value)}/><FormField label="Total tax (₹)" type="number" value={data.tax} onChange={value=>update('tax',value)}/><FormField label="Grand total on bill (₹)" type="number" value={data.totalWritten} onChange={value=>update('totalWritten',value)}/><label className="form-field-v2"><span>Place of supply</span><select value={data.posStateCode} onChange={event=>update('posStateCode',event.target.value)}><option value="">Choose state</option>{Object.entries(STATE_CODES).map(([code,state])=><option key={code} value={code}>{code} · {state}</option>)}</select></label></div><footer><button type="button" className="button-v2 secondary-v2" onClick={onClose}>Cancel</button><button className="button-v2 primary-v2" type="submit"><Check size={16}/> Add and review</button></footer></form></div>; }
