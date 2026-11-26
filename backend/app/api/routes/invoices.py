from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Response

from app.api.dependencies import get_active_business
from app.api.routes.documents import audit, extraction
from app.schemas.audit import AuditEvent
from app.schemas.gstr1 import GSTR1Record
from app.schemas.invoice import CanonicalInvoice, InvoiceSummary
from app.schemas.validation import ValidationResponse
from app.services.audit_service import record_safely
from app.services.auth_service import BusinessRecord
from app.services.export_service import (
    ExportArtifact,
    ExportNotReadyError,
    ExportService,
)
from app.services.gstr1_service import GSTR1Service

router = APIRouter(prefix="/invoices", tags=["invoices"])
gstr1 = GSTR1Service()
exports = ExportService(gstr1)

INVOICE_NOT_FOUND = "Invoice not found"

EXPORT_MEDIA_TYPES = {
    "json": "application/json",
    "csv": "text/csv; charset=utf-8",
}


def owned_invoice(invoice_id: str, business: BusinessRecord) -> CanonicalInvoice:
    """Resolve an invoice inside the active business before doing anything else.

    Missing, legacy-unowned and other-business invoices all raise the same 404,
    so existence is never disclosed.
    """
    try:
        return extraction.invoice_owned(invoice_id, business.id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=INVOICE_NOT_FOUND) from error


@router.get("", response_model=list[InvoiceSummary])
def list_invoices(
    business: BusinessRecord = Depends(get_active_business),
) -> list[InvoiceSummary]:
    """Invoices owned by the active business; legacy unowned records excluded."""
    return [
        InvoiceSummary(
            invoice_id=invoice_id,
            invoice_number=invoice.invoice_number,
            invoice_date=invoice.invoice_date,
            transaction_direction=invoice.transaction_direction,
            supplier_name=invoice.supplier.name,
            buyer_name=invoice.buyer.name,
            buyer_gstin=invoice.buyer.gstin,
            place_of_supply_state_code=invoice.place_of_supply_state_code,
            taxable_value=invoice.totals.taxable_value,
            cgst_total=invoice.totals.cgst_total,
            sgst_total=invoice.totals.sgst_total,
            igst_total=invoice.totals.igst_total,
            cess_total=invoice.totals.cess_total,
            grand_total=invoice.totals.grand_total,
            document_id=extraction.documents.find_by_invoice(
                invoice_id, business_id=business.id
            ),
        )
        for invoice_id, invoice in extraction.list_owned(business.id)
    ]


@router.get("/{invoice_id}", response_model=CanonicalInvoice)
def get_invoice(
    invoice_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> CanonicalInvoice:
    return owned_invoice(invoice_id, business)


@router.get("/{invoice_id}/gstr1", response_model=GSTR1Record)
def get_invoice_gstr1(
    invoice_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> GSTR1Record:
    invoice = owned_invoice(invoice_id, business)

    try:
        record = gstr1.build_record(invoice)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    document_id = extraction.documents.find_by_invoice(
        invoice_id, business_id=business.id
    )
    if document_id is not None:
        record_safely(
            audit,
            event_type="gstr1_generated",
            status="completed",
            message="Internal GSTR-1 representation generated.",
            document_id=document_id,
            invoice_id=invoice_id,
            business_id=business.id,
            metadata={"invoice_type": record.invoice_type},
        )

    return record


@router.get("/{invoice_id}/audit", response_model=list[AuditEvent])
def get_invoice_audit(
    invoice_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> list[AuditEvent]:
    owned_invoice(invoice_id, business)
    return audit.list_for_invoice(invoice_id, business_id=business.id)


def _export_response(
    invoice_id: str,
    business: BusinessRecord,
    builder: Callable[[CanonicalInvoice, ValidationResponse], ExportArtifact],
    event_type: str,
    export_format: str,
) -> Response:
    invoice = owned_invoice(invoice_id, business)

    validation = extraction.validator.validate(invoice)

    try:
        artifact = builder(invoice, validation)
    except ExportNotReadyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    document_id = extraction.documents.find_by_invoice(
        invoice_id, business_id=business.id
    )
    if document_id is not None:
        record_safely(
            audit,
            event_type=event_type,
            status="completed",
            message=f"{export_format.upper()} export generated.",
            document_id=document_id,
            invoice_id=invoice_id,
            business_id=business.id,
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
def export_invoice_json(
    invoice_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> Response:
    return _export_response(
        invoice_id, business, exports.json_export, "export_json_generated", "json"
    )


@router.get("/{invoice_id}/export/csv")
def export_invoice_csv(
    invoice_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> Response:
    return _export_response(
        invoice_id, business, exports.csv_export, "export_csv_generated", "csv"
    )


@router.post("/{invoice_id}/validate", response_model=ValidationResponse)
def validate_invoice(
    invoice_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> ValidationResponse:
    # Validation of a *stored* invoice is business-owned data, so it is scoped
    # exactly like the read endpoints. `/api/invoices/validate` (a request-body
    # only endpoint) stays unauthenticated — see `routes/validation.py`.
    owned_invoice(invoice_id, business)
    return extraction.validation_owned(invoice_id, business.id)
