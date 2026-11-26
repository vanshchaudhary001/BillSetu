from pathlib import Path
from uuid import uuid4

from app.core.config import settings
from app.schemas.documents import DocumentRecord
from app.schemas.invoice import CanonicalInvoice
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