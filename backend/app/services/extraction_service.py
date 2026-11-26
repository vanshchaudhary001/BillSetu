from pathlib import Path
from uuid import uuid4

from app.core.config import settings
from app.schemas.documents import DocumentRecord
from app.schemas.invoice import CanonicalInvoice, InvoiceTotals, LineItem, Party
from app.schemas.validation import ValidationResponse
from app.services.audit_service import AuditService, record_safely
from app.services.document_service import DocumentService
from app.services.gemini_service import GeminiService
from app.services.validation_engine import ValidationEngine
from app.storage.invoice_records import build_invoice_payload, parse_invoice_payload
from app.storage.json_store import read_json, write_json_atomic


class DocumentQuarantinedError(RuntimeError):
    """Raised when a quarantined document is submitted for extraction."""


class OwnershipConflictError(RuntimeError):
    """Raised when a document would produce an invoice for another business."""


VALIDATION_AUDIT_STATUS = {
    "validated": "completed",
    "review_required": "review_required",
    "blocked": "blocked",
}


class ExtractionService:
    def __init__(
        self,
        documents: DocumentService,
        gemini: GeminiService,
        validator: ValidationEngine,
        audit: AuditService | None = None,
    ) -> None:
        self.documents = documents
        self.gemini = gemini
        self.validator = validator
        self.audit = audit
        self.invoices: dict[str, CanonicalInvoice] = {}
        self.validations: dict[str, ValidationResponse] = {}
        # Ownership is persisted alongside the invoice payload rather than
        # inside `CanonicalInvoice`, which stays an extraction-only contract.
        self._invoice_business: dict[str, str | None] = {}
        self._metadata_path = Path(settings.storage_root).parent / "invoices.json"
        self._load_invoices()

    def extract(
        self, document_id: str, business_id: str | None = None
    ) -> tuple[DocumentRecord, str, ValidationResponse]:
        document = self.documents.get(document_id)
        owner_id = self._resolve_owner(document, business_id)

        if document.status == "quarantined":
            record_safely(
                self.audit,
                event_type="extraction_failed",
                status="blocked",
                message="Extraction refused because the document is quarantined.",
                document_id=document_id,
                business_id=owner_id,
            )
            raise DocumentQuarantinedError(
                "Document is quarantined and cannot be sent to Gemini"
            )

        record_safely(
            self.audit,
            event_type="extraction_started",
            status="started",
            message="Extraction request sent to the configured extraction provider.",
            document_id=document_id,
            business_id=owner_id,
            metadata={"media_type": document.media_type},
        )

        try:
            invoice = self.gemini.extract(
                self.documents.bytes_for(document_id),
                document.media_type,
            )
        except Exception as error:
            fallback_inv = None
            if document.media_type == "application/pdf":
                try:
                    fallback_inv = self._extract_pdf_deterministic(
                        self.documents.bytes_for(document_id)
                    )
                except Exception as fb_err:
                    print(f"Fallback extraction failed: {fb_err}", flush=True)
            if fallback_inv is not None:
                invoice = fallback_inv
            else:
                record_safely(
                    self.audit,
                    event_type="extraction_failed",
                    status="failed",
                    message="Extraction provider failed.",
                    document_id=document_id,
                    business_id=owner_id,
                    metadata={"error_type": type(error).__name__},
                )
                raise

        invoice_id = str(uuid4())

        # Persist first: audit events must never claim a canonical invoice was
        # created when the process could lose it on restart.
        self.invoices[invoice_id] = invoice
        self._invoice_business[invoice_id] = owner_id
        self._persist_invoices()

        record_safely(
            self.audit,
            event_type="extraction_completed",
            status="completed",
            message="Canonical invoice created from the extracted document.",
            document_id=document_id,
            invoice_id=invoice_id,
            business_id=owner_id,
            metadata={"invoice_number": invoice.invoice_number},
        )

        validation = self.validator.validate(invoice)

        self._record_validation(document_id, invoice_id, validation)

        self.validations[invoice_id] = validation

        self.documents.mark(
            document_id,
            status="extracted",
            invoice_id=invoice_id,
        )

        return self.documents.get(document_id), invoice_id, validation

    def invoice(self, invoice_id: str) -> CanonicalInvoice:
        invoice = self._lookup_invoice(invoice_id)
        if invoice is None:
            raise KeyError(invoice_id)
        return invoice

    def invoice_owned(self, invoice_id: str, business_id: str) -> CanonicalInvoice:
        """Business-scoped invoice lookup: id and owner are resolved together.

        A missing invoice, a legacy unowned invoice and an invoice owned by
        another business raise the same `KeyError`, so a caller cannot learn
        that a record exists outside its own business.
        """
        invoice = self._lookup_invoice(invoice_id)
        if (
            invoice is None
            or not business_id
            or self._invoice_business.get(invoice_id) != business_id
        ):
            raise KeyError(invoice_id)
        return invoice

    def list_owned(self, business_id: str) -> list[tuple[str, CanonicalInvoice]]:
        """Invoices owned by `business_id`; legacy unowned records are excluded."""
        if not business_id:
            return []
        if not self.invoices:
            self._load_invoices()
        return [
            (invoice_id, invoice)
            for invoice_id, invoice in sorted(self.invoices.items())
            if self._invoice_business.get(invoice_id) == business_id
        ]

    def invoice_business_id(self, invoice_id: str) -> str | None:
        """Owning business of a stored invoice, or None for a legacy record."""
        self.invoice(invoice_id)
        return self._invoice_business.get(invoice_id)

    def _lookup_invoice(self, invoice_id: str) -> CanonicalInvoice | None:
        if invoice_id not in self.invoices:
            self._load_invoices()
        return self.invoices.get(invoice_id)

    def _resolve_owner(
        self, document: DocumentRecord, requested_business_id: str | None
    ) -> str | None:
        """Keep a document and the invoice extracted from it under one owner."""
        document_owner = document.business_id
        if (
            document_owner is not None
            and requested_business_id is not None
            and document_owner != requested_business_id
        ):
            raise OwnershipConflictError(
                "Document belongs to a different business than the requested context"
            )
        if document_owner is not None:
            return document_owner
        # Legacy unowned document: the new invoice is created under the caller's
        # business, while the document itself is not retroactively claimed.
        return requested_business_id

    def validation(self, invoice_id: str) -> ValidationResponse:
        invoice = self.invoice(invoice_id)
        validation = self.validator.validate(invoice)
        self.validations[invoice_id] = validation
        self._record_validation(
            self.documents.find_by_invoice(
                invoice_id, self._invoice_business.get(invoice_id)
            ),
            invoice_id,
            validation,
        )
        return validation

    def validation_owned(
        self, invoice_id: str, business_id: str
    ) -> ValidationResponse:
        self.invoice_owned(invoice_id, business_id)
        return self.validation(invoice_id)

    def _record_validation(
        self,
        document_id: str | None,
        invoice_id: str,
        validation: ValidationResponse,
    ) -> None:
        if document_id is None:
            return
        record_safely(
            self.audit,
            event_type="validation_completed",
            status=VALIDATION_AUDIT_STATUS[validation.status],
            message=f"Deterministic validation finished with status '{validation.status}'.",
            document_id=document_id,
            invoice_id=invoice_id,
            business_id=self._invoice_business.get(invoice_id),
            metadata={
                "issue_count": len(validation.issues),
                "error_count": validation.summary.error_count,
                "warning_count": validation.summary.warning_count,
            },
        )

    def _load_invoices(self) -> None:
        for invoice_id, entry in parse_invoice_payload(
            read_json(self._metadata_path, {})
        ).items():
            self.invoices[invoice_id] = CanonicalInvoice.model_validate(
                entry["invoice"]
            )
            self._invoice_business[invoice_id] = entry["business_id"]

    def _persist_invoices(self) -> None:
        records = {
            invoice_id: {
                "business_id": self._invoice_business.get(invoice_id),
                "invoice": invoice.model_dump(mode="json"),
            }
            for invoice_id, invoice in self.invoices.items()
        }
        write_json_atomic(self._metadata_path, build_invoice_payload(records))

    @staticmethod
    def _extract_pdf_deterministic(data: bytes) -> CanonicalInvoice | None:
        import re
        from io import BytesIO
        from decimal import Decimal
        from datetime import datetime
        import pdfplumber

        text = ""
        try:
            with pdfplumber.open(BytesIO(data)) as pdf:
                text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        except Exception:
            text = ""

        if not text.strip():
            return None

        inv_match = re.search(
            r'(?:Invoice|Bill|Voucher)\s*(?:No|Number|#)\s*[:.-]?\s*([A-Za-z0-9\/-]{3,30})',
            text,
            re.I,
        )
        if not inv_match:
            inv_match = re.search(r'\b([A-Za-z]{2,5}\/\d{2,4}[-\/]\d{2,4}\/[A-Za-z0-9-]+)\b', text)
        if not inv_match:
            inv_match = re.search(r'(?:Invoice|Bill|Voucher)\s*[:.-]\s*([A-Za-z0-9\/-]{3,30})', text, re.I)
        invoice_number = inv_match.group(1).strip() if inv_match else f"INV-{uuid4().hex[:6].upper()}"

        invoice_date = None
        date_match = re.search(
            r'(?:Invoice|Bill|Document)?\s*Date\s*[:.-]?\s*(\d{1,2}[-\/.][A-Za-z0-9]+[-\/.]\d{2,4})',
            text,
            re.I,
        )
        if not date_match:
            date_match = re.search(
                r'\b(\d{1,2}[-\/.](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2})[-\/.]\d{2,4})\b',
                text,
                re.I,
            )
        if date_match:
            raw_d = date_match.group(1).strip()
            for fmt in ("%d-%b-%Y", "%d/%b/%Y", "%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d"):
                try:
                    invoice_date = datetime.strptime(raw_d, fmt).date()
                    break
                except ValueError:
                    pass

        gstins = re.findall(r'\b\d{2}[A-Z]{5}\d{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}\b', text)
        supplier_gstin = gstins[0] if len(gstins) > 0 else None
        buyer_gstin = gstins[1] if len(gstins) > 1 else None

        pos_state_code = supplier_gstin[:2] if supplier_gstin else "07"
        pos_match = re.search(r'Place\s*of\s*Supply\s*[:.-]?\s*([A-Za-z ]+)', text, re.I)
        if pos_match and supplier_gstin:
            pos_state_code = supplier_gstin[:2]

        def clean_money(val: str | None) -> Decimal:
            if not val:
                return Decimal("0")
            cleaned = re.sub(r'[^\d.-]', '', val.replace(',', ''))
            try:
                return Decimal(cleaned)
            except Exception:
                return Decimal("0")

        taxable_match = re.search(r'Taxable\s*Value\s*(?:[:.-]?\s*(?:[₹nRs]\.?)?\s*)?([\d,]+(?:\.\d{2})?)', text, re.I)
        taxable_value = clean_money(taxable_match.group(1)) if taxable_match else Decimal("0")

        cgst_match = re.search(r'CGST\s*(?:@\s*\d+%?)?\s*[:.-]?\s*([\d,]+(?:\.\d{2})?)', text, re.I)
        cgst_total = clean_money(cgst_match.group(1)) if cgst_match else Decimal("0")

        sgst_match = re.search(r'SGST\s*(?:@\s*\d+%?)?\s*[:.-]?\s*([\d,]+(?:\.\d{2})?)', text, re.I)
        sgst_total = clean_money(sgst_match.group(1)) if sgst_match else Decimal("0")

        igst_match = re.search(r'IGST\s*(?:@\s*\d+%?)?\s*[:.-]?\s*([\d,]+(?:\.\d{2})?)', text, re.I)
        igst_total = clean_money(igst_match.group(1)) if igst_match else Decimal("0")

        cess_match = re.search(r'Cess\s*[:.-]?\s*([\d,]+(?:\.\d{2})?)', text, re.I)
        cess_total = clean_money(cess_match.group(1)) if cess_match else Decimal("0")

        total_match = re.search(r'(?:Grand\s*Total|Invoice\s*Total|Total\s*Amount)\s*(?:[:.-]?\s*(?:[₹nRs]\.?)?\s*)?([\d,]+(?:\.\d{2})?)', text, re.I)
        grand_total = clean_money(total_match.group(1)) if total_match else (taxable_value + cgst_total + sgst_total + igst_total + cess_total)

        lines = [l.strip() for l in text.split("\n") if l.strip()]
        supplier_name = "Supplier"
        buyer_name = "Buyer"
        for l in lines:
            if "TAX INVOICE" in l.upper():
                continue
            if re.search(r'LIMITED|PVT|LTD|ENTERPRISES|SOLUTIONS|TRADERS|STORE|COMPANY', l, re.I) and not re.search(r'GSTIN|Bill To|Ship To', l, re.I):
                supplier_name = l.split("Invoice No")[0].strip()
                break

        buyer_match = re.search(r'Bill\s*To(?:[^\n]*)\n([^\n]+)', text, re.I)
        if buyer_match:
            candidate = buyer_match.group(1).strip()
            words = candidate.split()
            half = len(words) // 2
            if half > 0 and words[:half] == words[half:]:
                candidate = " ".join(words[:half])
            buyer_name = candidate
        else:
            buyer_match2 = re.search(r'(?:Customer|Buyer)\s*(?:Name)?\s*[:.-]?\s*([^\n]+)', text, re.I)
            if buyer_match2:
                candidate = buyer_match2.group(1).strip()
                if not re.search(r'GSTIN|Address|Ship To', candidate, re.I):
                    buyer_name = candidate

        line_items = []
        for l in lines:
            m = re.match(r'^\d+\s+([A-Za-z0-9 -]+?)\s+(\d{4,8})\s+(\d+(?:\.\d+)?)\s+([\d,.]+)\s+([\d,.]+)', l)
            if m:
                desc, hsn, qty, rate, val = m.groups()
                item_val = clean_money(val)
                line_items.append(LineItem(
                    description=desc.strip(),
                    hsn_sac=hsn.strip(),
                    quantity=clean_money(qty) or Decimal("1"),
                    unit_rate=clean_money(rate),
                    taxable_value=item_val,
                    gst_rate_pct=Decimal("18") if (cgst_total or sgst_total) else Decimal("0"),
                    cgst_amount=(item_val * Decimal("0.09")).quantize(Decimal("0.01")),
                    sgst_amount=(item_val * Decimal("0.09")).quantize(Decimal("0.01"))
                ))

        if not line_items and taxable_value > 0:
            line_items.append(LineItem(
                description="Extracted invoice goods / services",
                quantity=Decimal("1"),
                unit_rate=taxable_value,
                taxable_value=taxable_value,
                gst_rate_pct=Decimal("18") if (cgst_total or sgst_total) else Decimal("0"),
                cgst_amount=cgst_total,
                sgst_amount=sgst_total,
                igst_amount=igst_total,
                cess_amount=cess_total
            ))

        return CanonicalInvoice(
            document_type="tax_invoice",
            transaction_direction="outward_sale",
            invoice_number=invoice_number,
            invoice_date=invoice_date,
            supplier=Party(
                name=supplier_name,
                gstin=supplier_gstin,
                state_code=supplier_gstin[:2] if supplier_gstin else "07",
                address_present=True
            ),
            buyer=Party(
                name=buyer_name,
                gstin=buyer_gstin,
                state_code=buyer_gstin[:2] if buyer_gstin else "07",
                address_present=True
            ),
            place_of_supply_state_code=pos_state_code,
            totals=InvoiceTotals(
                taxable_value=taxable_value,
                cgst_total=cgst_total,
                sgst_total=sgst_total,
                igst_total=igst_total,
                cess_total=cess_total,
                grand_total=grand_total
            ),
            line_items=line_items,
            document_quality_notes=["Extracted via local deterministic engine"]
        )