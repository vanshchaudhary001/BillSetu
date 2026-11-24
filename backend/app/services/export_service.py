import csv
import io
import json
import re
from typing import NamedTuple

from app.schemas.gstr1 import GSTR1LineItem, GSTR1Record
from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationResponse
from app.services.gstr1_service import GSTR1Service

EXPORT_BLOCKED_MESSAGE = (
    "Invoice is not export ready; resolve the validation issues before exporting."
)

FILENAME_COMPONENT_MAX_LENGTH = 64
FILENAME_FALLBACK = "invoice"

CSV_COLUMNS = (
    "invoice_number",
    "invoice_date",
    "invoice_type",
    "supplier_gstin",
    "buyer_gstin",
    "place_of_supply_state_code",
    "reverse_charge",
    "line_description",
    "hsn_sac",
    "quantity",
    "taxable_value",
    "gst_rate_pct",
    "cgst_amount",
    "sgst_amount",
    "igst_amount",
    "cess_amount",
    "invoice_taxable_value",
    "invoice_cgst_total",
    "invoice_sgst_total",
    "invoice_igst_total",
    "invoice_cess_total",
    "grand_total",
)


class ExportNotReadyError(Exception):
    """Raised when the authoritative validation result blocks export."""


class ExportArtifact(NamedTuple):
    content: bytes
    filename: str
    invoice_type: str


def sanitize_filename_component(value: str) -> str:
    """Reduce arbitrary invoice text to a safe single filename component."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (value or "").strip())
    cleaned = re.sub(r"\.{2,}", ".", cleaned).strip("._")
    cleaned = cleaned[:FILENAME_COMPONENT_MAX_LENGTH].strip("._")
    return cleaned or FILENAME_FALLBACK


def export_filename(invoice_number: str, extension: str) -> str:
    return f"billsetu_{sanitize_filename_component(invoice_number)}_gstr1.{extension}"


def _cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class ExportService:
    """Builds downloadable artifacts from the internal GSTR-1 representation.

    Export readiness comes from the existing ValidationResponse; this service
    never re-implements compliance rules and never calls Gemini.
    """

    def __init__(self, gstr1: GSTR1Service | None = None) -> None:
        self._gstr1 = gstr1 or GSTR1Service()

    def json_export(
        self, invoice: CanonicalInvoice, validation: ValidationResponse
    ) -> ExportArtifact:
        record = self._exportable_record(invoice, validation)
        content = (
            json.dumps(record.model_dump(mode="json"), ensure_ascii=False, indent=2)
            + "\n"
        ).encode("utf-8")
        return ExportArtifact(
            content=content,
            filename=export_filename(record.invoice_number, "json"),
            invoice_type=record.invoice_type,
        )

    def csv_export(
        self, invoice: CanonicalInvoice, validation: ValidationResponse
    ) -> ExportArtifact:
        record = self._exportable_record(invoice, validation)
        return ExportArtifact(
            content=self._csv_content(record),
            filename=export_filename(record.invoice_number, "csv"),
            invoice_type=record.invoice_type,
        )

    def _exportable_record(
        self, invoice: CanonicalInvoice, validation: ValidationResponse
    ) -> GSTR1Record:
        if not validation.export_ready:
            raise ExportNotReadyError(EXPORT_BLOCKED_MESSAGE)
        return self._gstr1.build_record(invoice)

    @staticmethod
    def _csv_content(record: GSTR1Record) -> bytes:
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(CSV_COLUMNS)
        for line in record.line_items:
            writer.writerow(ExportService._csv_row(record, line))
        return buffer.getvalue().encode("utf-8")

    @staticmethod
    def _csv_row(record: GSTR1Record, line: GSTR1LineItem) -> list[str]:
        return [
            _cell(record.invoice_number),
            record.invoice_date.isoformat(),
            record.invoice_type,
            _cell(record.supplier_gstin),
            _cell(record.buyer_gstin),
            _cell(record.place_of_supply_state_code),
            _cell(record.reverse_charge),
            _cell(line.description),
            _cell(line.hsn_sac),
            _cell(line.quantity),
            _cell(line.taxable_value),
            _cell(line.gst_rate_pct),
            _cell(line.cgst_amount),
            _cell(line.sgst_amount),
            _cell(line.igst_amount),
            _cell(line.cess_amount),
            _cell(record.taxable_value),
            _cell(record.cgst_total),
            _cell(record.sgst_total),
            _cell(record.igst_total),
            _cell(record.cess_total),
            _cell(record.grand_total),
        ]
