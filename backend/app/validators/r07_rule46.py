from datetime import date

from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue


def validate(invoice: CanonicalInvoice) -> list[ValidationIssue]:
    results = []
    if not invoice.supplier.name:
        results.append(issue("R07", "error", "supplier.name", "Supplier name is required.", "आपूर्तिकर्ता का नाम जरूरी है।"))
    if not invoice.invoice_date or invoice.invoice_date > date.today():
        results.append(issue("R07", "error", "invoice_date", "Invoice date is missing or in the future.", "इनवॉइस की तारीख नहीं है या भविष्य की है।"))
    for index, line in enumerate(invoice.line_items):
        if not line.description:
            results.append(issue("R07", "error", f"line_items[{index}].description", "Line item description is required.", "लाइन आइटम का विवरण जरूरी है।"))
    if not invoice.buyer.gstin and invoice.totals.taxable_value >= 50000:
        if not invoice.buyer.name:
            results.append(issue("R07", "error", "buyer.name", "Buyer name is required for a high-value unregistered B2C supply.", "उच्च-मूल्य B2C सप्लाई के लिए खरीदार का नाम जरूरी है।"))
        if not invoice.buyer.address_present or not invoice.buyer.state_code:
            results.append(issue("R07", "error", "buyer.address_present", "Buyer address and state are required for this B2C invoice.", "इस B2C इनवॉइस के लिए खरीदार का पता और स्टेट जरूरी है।"))
    return results
