from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue, money


def validate(invoice: CanonicalInvoice) -> list[ValidationIssue]:
    results = []
    for index, line in enumerate(invoice.line_items):
        expected_taxable = money(line.quantity * line.unit_rate - line.discount)
        if abs(expected_taxable - money(line.taxable_value)) > money("0.50"):
            results.append(issue("R02", "error", f"line_items[{index}].taxable_value", "Quantity × rate − discount does not match taxable value.", "मात्रा × दर − छूट, कर योग्य मूल्य से मेल नहीं खाता।"))
        expected_tax = money(line.taxable_value * line.gst_rate_pct / 100)
        actual_tax = money(line.cgst_amount + line.sgst_amount + line.igst_amount)
        if abs(expected_tax - actual_tax) > money("1.00"):
            results.append(issue("R02", "error", f"line_items[{index}].gst_rate_pct", "Line tax does not match the declared GST rate.", "लाइन टैक्स घोषित GST दर से मेल नहीं खाता।"))
    return results
