from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue, money


def validate(invoice: CanonicalInvoice) -> list[ValidationIssue]:
    supplier = invoice.supplier.state_code
    pos = invoice.place_of_supply_state_code
    if not supplier or not pos:
        return [issue("R04", "error", "place_of_supply_state_code", "Supplier state and place of supply are required to validate tax heads.", "税 हेड की जांच के लिए सप्लायर स्टेट और सप्लाई स्थान जरूरी है।")] if invoice.totals.grand_total else []
    same_state = supplier == pos
    results = []
    if same_state and (invoice.totals.igst_total != 0 or abs(invoice.totals.cgst_total - invoice.totals.sgst_total) > money("0.05")):
        results.append(issue("R04", "error", "totals", "Intra-state supply must use equal CGST and SGST, with no IGST.", "इंट्रा-स्टेट सप्लाई में बराबर CGST और SGST होना चाहिए, IGST नहीं।", legal_ref="IGST Act Sections 10/12"))
    if not same_state and (invoice.totals.cgst_total != 0 or invoice.totals.sgst_total != 0 or (invoice.totals.taxable_value > 0 and invoice.totals.igst_total <= 0)):
        results.append(issue("R04", "error", "totals", "Inter-state supply must use IGST, with no CGST or SGST.", "इंटर-स्टेट सप्लाई में IGST होना चाहिए, CGST या SGST नहीं।", legal_ref="IGST Act Sections 10/12"))
    return results
