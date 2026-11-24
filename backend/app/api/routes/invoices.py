from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Response

from app.schemas.audit import AuditEvent
from app.schemas.gstr1 import GSTR1Record
from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ValidationResponse
from app.services.audit_service import record_safely
from app.services.export_service import (
    ExportArtifact,
    ExportNotReadyError,
    ExportService,
)
from app.services.gstr1_service import GSTR1Service
from app.api.routes.documents import audit, extraction

router = APIRouter(prefix="/invoices", tags=["invoices"])
gstr1 = GSTR1Service()
exports = ExportService(gstr1)

EXPORT_MEDIA_TYPES = {
    "json": "application/json",
    "csv": "text/csv; charset=utf-8",
}


@router.get("/{invoice_id}", response_model=CanonicalInvoice)
def get_invoice(invoice_id: str) -> CanonicalInvoice:
    try:
        return extraction.invoice(invoice_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Invoice not found") from error


@router.get("/{invoice_id}/gstr1", response_model=GSTR1Record)
def get_invoice_gstr1(invoice_id: str) -> GSTR1Record:
    try:
        invoice = extraction.invoice(invoice_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Invoice not found") from error

    try:
        record = gstr1.build_record(invoice)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    document_id = extraction.documents.find_by_invoice(invoice_id)
    if document_id is not None:
        record_safely(
            audit,
            event_type="gstr1_generated",
            status="completed",
            message="Internal GSTR-1 representation generated.",
            document_id=document_id,
            invoice_id=invoice_id,
            metadata={"invoice_type": record.invoice_type},
        )

    return record


@router.get("/{invoice_id}/audit", response_model=list[AuditEvent])
def get_invoice_audit(invoice_id: str) -> list[AuditEvent]:
    try:
        extraction.invoice(invoice_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Invoice not found") from error
    return audit.list_for_invoice(invoice_id)


def _export_response(
    invoice_id: str,
    builder: Callable[[CanonicalInvoice, ValidationResponse], ExportArtifact],
    event_type: str,
    export_format: str,
) -> Response:
    try:
        invoice = extraction.invoice(invoice_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Invoice not found") from error

    validation = extraction.validator.validate(invoice)

    try:
        artifact = builder(invoice, validation)
    except ExportNotReadyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    document_id = extraction.documents.find_by_invoice(invoice_id)
    if document_id is not None:
        record_safely(
            audit,
            event_type=event_type,
            status="completed",
            message=f"{export_format.upper()} export generated.",
            document_id=document_id,
            invoice_id=invoice_id,
            metadata={
                "format": export_format,
                "invoice_number": invoice.invoice_number,
                "invoice_type": artifact.invoice_type,
            },
        )

    return Response(
        content=artifact.content,
        media_type=EXPORT_MEDIA_TYPES[export_format],
        headers={
            "Content-Disposition": f'attachment; filename="{artifact.filename}"',
        },
    )


@router.get("/{invoice_id}/export/json")
def export_invoice_json(invoice_id: str) -> Response:
    return _export_response(
        invoice_id, exports.json_export, "export_json_generated", "json"
    )


@router.get("/{invoice_id}/export/csv")
def export_invoice_csv(invoice_id: str) -> Response:
    return _export_response(
        invoice_id, exports.csv_export, "export_csv_generated", "csv"
    )


@router.post("/{invoice_id}/validate", response_model=ValidationResponse)
def validate_invoice(invoice_id: str) -> ValidationResponse:
    try:
        return extraction.validation(invoice_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Invoice not found") from error
