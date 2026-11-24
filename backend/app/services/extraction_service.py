import json
import os
import tempfile
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

class DocumentQuarantinedError(RuntimeError):
    """Raised when a quarantined document is submitted for extraction."""


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
        self._metadata_path = Path(settings.storage_root).parent / "invoices.json"
        self._load_invoices()

    def extract(
        self, document_id: str
    ) -> tuple[DocumentRecord, str, ValidationResponse]:
        document = self.documents.get(document_id)

        if document.status == "quarantined":
            record_safely(
                self.audit,
                event_type="extraction_failed",
                status="blocked",
                message="Extraction refused because the document is quarantined.",
                document_id=document_id,
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
                metadata={"error_type": type(error).__name__},
            )
            raise

        invoice_id = str(uuid4())

        # Persist first: audit events must never claim a canonical invoice was
        # created when the process could lose it on restart.
        self.invoices[invoice_id] = invoice
        self._persist_invoices()

        record_safely(
            self.audit,
            event_type="extraction_completed",
            status="completed",
            message="Canonical invoice created from the extracted document.",
            document_id=document_id,
            invoice_id=invoice_id,
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
        if invoice_id not in self.invoices:
            self._load_invoices()

        if invoice_id not in self.invoices:
            raise KeyError(invoice_id)

        return self.invoices[invoice_id]

    def validation(self, invoice_id: str) -> ValidationResponse:
        invoice = self.invoice(invoice_id)
        validation = self.validator.validate(invoice)
        self.validations[invoice_id] = validation
        self._record_validation(
            self.documents.find_by_invoice(invoice_id), invoice_id, validation
        )
        return validation

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
            metadata={
                "issue_count": len(validation.issues),
                "error_count": validation.summary.error_count,
                "warning_count": validation.summary.warning_count,
            },
        )

    def _load_invoices(self) -> None:
        if not self._metadata_path.exists():
            return

        with self._metadata_path.open("r", encoding="utf-8") as invoice_file:
            payload = json.load(invoice_file)

        for invoice_id, entry in payload.items():
            self.invoices[invoice_id] = CanonicalInvoice.model_validate(entry)

    def _persist_invoices(self) -> None:
        self._metadata_path.parent.mkdir(parents=True, exist_ok=True)

        payload = {
            invoice_id: invoice.model_dump(mode="json")
            for invoice_id, invoice in self.invoices.items()
        }

        temporary_path: str | None = None

        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self._metadata_path.parent,
                prefix=".invoices-",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = temporary_file.name

                json.dump(
                    payload,
                    temporary_file,
                    ensure_ascii=False,
                    indent=2,
                )

                temporary_file.flush()
                os.fsync(temporary_file.fileno())

            Path(temporary_path).replace(self._metadata_path)

        finally:
            if temporary_path and Path(temporary_path).exists():
                Path(temporary_path).unlink()