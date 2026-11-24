from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationIssue
from app.validators.common import issue


def validate(invoice: CanonicalInvoice) -> list[ValidationIssue]:
    results = []
    if invoice.document_type == "unreadable" or (invoice.image_sharpness is not None and invoice.image_sharpness < 0.25):
        results.append(issue("R12", "critical", "document_type", "Document is unreadable and has been quarantined for human review.", "दस्तावेज़ पढ़ने योग्य नहीं है और मानव समीक्षा के लिए रोक दिया गया है।"))
    if invoice.suspicious_instruction_text_detected:
        results.append(issue("R12", "critical", "suspicious_instruction_text_detected", "Instruction-like text in the document was quarantined as possible prompt injection.", "दस्तावेज़ के निर्देश जैसे टेक्स्ट को संभावित prompt injection मानकर रोक दिया गया है।"))
    return results
