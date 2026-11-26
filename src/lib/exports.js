
import { stateCodeForName } from './gst.js';

const money = value => Math.round((Number(value) || 0) * 100) / 100;
const safeCell = value => {
  const text = String(value ?? '');
  return /^[=+@\-]/.test(text) ? `'${text}` : text;
};
const dateForGST = value => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
};
const rateOf = invoice => {
  const gstTax = Number(invoice.cgst || 0) + Number(invoice.sgst || 0) + Number(invoice.igst || 0);
  const rateTax = gstTax || Math.max(0, Number(invoice.tax || 0) - Number(invoice.cess || 0));
  return money(invoice.amount ? (rateTax / Number(invoice.amount)) * 100 : 0);
};
const itemFor = (invoice, index = 1) => ({
  num: index,
  itm_det: {
    rt: rateOf(invoice),
    txval: money(invoice.amount),
    iamt: money(invoice.igst),
    camt: money(invoice.cgst),
    samt: money(invoice.sgst),
    csamt: money(invoice.cess),
  },
});
const invoiceValue = invoice => money(invoice.totalWritten || Number(invoice.amount || 0) + Number(invoice.tax || 0));

export function makeGstr1Draft(invoices, profile = {}, filingPeriod = 'October 2026') {
  const confirmed = invoices.filter(invoice => invoice.status === 'ready' && invoice.confirmed && invoice.direction !== 'purchase');
  const b2bGroups = new Map();
  const b2cl = [];
  const b2csGroups = new Map();
  for (const invoice of confirmed) {
    const date = dateForGST(invoice.isoDate || invoice.date);
    const pos = invoice.posStateCode || invoice.posCode || stateCodeForName(invoice.pos) || String(profile.gstin || '').slice(0, 2) || '09';
    const value = invoiceValue(invoice);
    const inv = { inum: String(invoice.no || '').slice(0, 16), idt: date, val: value, pos, rchrg: invoice.reverseCharge ? 'Y' : 'N', inv_typ: 'R', itms: [itemFor(invoice)] };
    if (/^\d{2}[A-Z0-9]{13}$/.test(String(invoice.gstin || '').toUpperCase())) {
      const ctin = String(invoice.gstin).toUpperCase();
      const group = b2bGroups.get(ctin) || { ctin, inv: [] };
      group.inv.push(inv); b2bGroups.set(ctin, group);
    } else if (pos !== String(profile.gstin || '').slice(0, 2) && value > 100000) {
      b2cl.push({ pos, inv: [inv] });
    } else {
      const rate = rateOf(invoice);
      const supplyType = pos === String(profile.gstin || '').slice(0, 2) ? 'INTRA' : 'INTER';
      const key = `${pos}|${rate}|${supplyType}`;
      const group = b2csGroups.get(key) || { pos, sply_ty: supplyType, typ: 'OE', rt: rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      group.txval = money(group.txval + Number(invoice.amount || 0));
      group.iamt = money(group.iamt + Number(invoice.igst || 0));
      group.camt = money(group.camt + Number(invoice.cgst || 0));
      group.samt = money(group.samt + Number(invoice.sgst || 0));
      group.csamt = money(group.csamt + Number(invoice.cess || 0));
      b2csGroups.set(key, group);
    }
  }
  const periodMatch = String(filingPeriod).match(/([A-Za-z]+)\s+(\d{4})/);
  const month = periodMatch ? new Date(`${periodMatch[1]} 1, ${periodMatch[2]}`).getMonth() + 1 : new Date().getMonth() + 1;
  const year = periodMatch ? periodMatch[2] : String(new Date().getFullYear());
  return {
    gstin: String(profile.gstin || ''),
    fp: `${String(month).padStart(2, '0')}${year}`,
    version: 'BillSetu-local-draft',
    _billsetu_notice: 'Preparation draft only. This locally generated structure has not been certified against the currently downloaded GSTN offline tool/schema. Import and validate it in the official GST utility, then have the taxpayer or CA review it. Bill Setu does not file returns.',
    b2b: [...b2bGroups.values()],
    b2cl,
    b2cs: [...b2csGroups.values()],
    hsn: { data: [] },
    doc_issue: [],
  };
}

export async function makeCAWorkbook(invoices, profile = {}, auditEntries = []) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bill Setu';
  workbook.created = new Date();
  workbook.subject = 'GST pre-filing review pack';
  workbook.views = [{ state: 'frozen', ySplit: 1 }];
  const addSheet = (name, columns, rows) => {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = columns.map(([header, key, width = 20]) => ({ header, key, width, style: { alignment: { vertical: 'middle' } } }));
    rows.forEach(row => sheet.addRow(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safeCell(value)]))));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF315B49' } };
    sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + columns.length)}1` };
    return sheet;
  };
  const headers = [['Invoice no', 'no'], ['Invoice date', 'date'], ['Buyer', 'party'], ['Buyer GSTIN', 'gstin'], ['Taxable value (INR)', 'amount'], ['CGST (INR)', 'cgst'], ['SGST (INR)', 'sgst'], ['IGST (INR)', 'igst'], ['Cess (INR)', 'cess'], ['Tax (INR)', 'tax'], ['Invoice value (INR)', 'totalWritten'], ['Place of supply', 'pos'], ['Return bucket', 'bucket'], ['Status', 'status'], ['Source file', 'source'], ['Review notes', 'notes']];
  const toRow = invoice => ({ ...invoice, notes: (invoice.issues || []).join('; ') || (invoice.confirmed ? 'Owner-confirmed' : 'Not confirmed') });
  addSheet('Outward sales', headers, invoices.filter(invoice => invoice.direction !== 'purchase').map(toRow));
  addSheet('Needs review', headers, invoices.filter(invoice => invoice.direction !== 'purchase' && invoice.status !== 'ready').map(toRow));
  addSheet('Purchases - ITC unverified', headers, invoices.filter(invoice => invoice.direction === 'purchase').map(toRow));
  const auditSheet = workbook.addWorksheet('Activity log');
  auditSheet.columns = [{ header: 'When', key: 'at', width: 24 }, { header: 'Invoice', key: 'invoice', width: 22 }, { header: 'Action', key: 'action', width: 25 }, { header: 'Details', key: 'details', width: 70 }];
  auditEntries.forEach(entry => auditSheet.addRow({ at: new Date(entry.at).toLocaleString('en-IN'), invoice: entry.invoice, action: entry.action, details: entry.details }));
  auditSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; auditSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF315B49' } };
  const guide = workbook.addWorksheet('Read me');
  guide.addRows([
    ['BILL SETU · CA REVIEW PACK'], ['Business', profile.name || 'Business name not configured'], ['GSTIN', profile.gstin || 'Not configured'], ['Purpose', 'Pre-filing preparation. This is not a filed return or legal opinion.'], ['Purchases', 'Purchase records are listed separately. ITC eligibility is not verified; reconcile with GSTR-2B/IMS and a CA.'], ['Draft export', 'Bill Setu generated a draft structure for review. Verify in the official GST portal/offline utility before use.'], ['Privacy', 'This file was generated locally in your browser.'],
  ]);
  guide.getColumn(1).width = 33; guide.getColumn(2).width = 100; guide.getRow(1).font = { bold: true, size: 16 };
  return workbook.xlsx.writeBuffer();
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
