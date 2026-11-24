from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue, money


def validate(invoice: CanonicalInvoice) -> list[ValidationIssue]:
    results = []
    line_taxable = money(sum((line.taxable_value for line in invoice.line_items), start=invoice.totals.taxable_value * 0))
    if abs(line_taxable - invoice.totals.taxable_value) > money("1.00"):
        results.append(issue("R03", "error", "totals.taxable_value", "Invoice taxable total does not match its line items.", "इनवॉइस का कर योग्य योग लाइन आइटम से मेल नहीं खाता।"))
    calculated = money(invoice.totals.taxable_value + invoice.totals.cgst_total + invoice.totals.sgst_total + invoice.totals.igst_total + invoice.totals.cess_total + invoice.totals.round_off)
    if abs(calculated - invoice.totals.grand_total) > money("1.00"):
        results.append(issue("R03", "error", "totals.grand_total", "Grand total does not reconcile with taxable value and taxes.", "ग्रैंड टोटल कर योग्य मूल्य और टैक्स से मेल नहीं खाता।"))
    return results
