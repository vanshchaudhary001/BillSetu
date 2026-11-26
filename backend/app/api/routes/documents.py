from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile

from app.api.dependencies import get_active_business
from app.schemas.audit import AuditEvent
from app.schemas.documents import DocumentRecord, ExtractResponse
from app.services.audit_service import AuditService
from app.services.auth_service import BusinessRecord
from app.services.document_service import DocumentService
from app.services.extraction_service import (
    DocumentQuarantinedError,
    ExtractionService,
    OwnershipConflictError,
)
from app.services.gemini_service import GeminiService
from app.services.validation_engine import ValidationEngine

router = APIRouter(prefix="/documents", tags=["documents"])
audit = AuditService()
documents = DocumentService(audit=audit)
extraction = ExtractionService(documents, GeminiService(), ValidationEngine(), audit=audit)

DOCUMENT_NOT_FOUND = "Document not found"


def owned_document(document_id: str, business: BusinessRecord) -> DocumentRecord:
    """Resolve a document inside the active business before anything else.

    Missing, legacy-unowned and other-business documents all raise the same
    404, so the response never reveals whether the id exists.
    """
    try:
        return documents.get_owned(document_id, business.id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND) from error


@router.get("", response_model=list[DocumentRecord])
def list_documents(
    business: BusinessRecord = Depends(get_active_business),
) -> list[DocumentRecord]:
    """Documents owned by the active business; legacy unowned records excluded."""
    return documents.list_owned(business.id)


@router.post("/upload", response_model=DocumentRecord, status_code=201)
async def upload_document(
    file: UploadFile = File(...),
    business: BusinessRecord = Depends(get_active_business),
) -> DocumentRecord:
    # Ownership comes from the authenticated session, never from the request body.
    return await documents.upload(file, business_id=business.id)


@router.get("/{document_id}", response_model=DocumentRecord)
def get_document(
    document_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> DocumentRecord:
    return owned_document(document_id, business)


@router.get("/{document_id}/content")
def get_document_content(
    document_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> Response:
    # The record is authorized first; the stored bytes are only read afterwards.
    record = owned_document(document_id, business)
    try:
        content = documents.bytes_for_owned(document_id, business.id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND) from error
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404, detail="Document content not found"
        ) from error

    return Response(
        content=content,
        media_type=record.media_type,
        headers={
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/{document_id}/extract", response_model=ExtractResponse)
def extract_document(
    document_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> ExtractResponse:
    # Extraction runs only for a document that already belongs to the active
    # business, so a document from business A can never yield an invoice here.
    owned_document(document_id, business)
    try:
        document, invoice_id, validation = extraction.extract(
            document_id, business_id=business.id
        )
        return ExtractResponse(
            document=document,
            invoice_id=invoice_id,
            invoice=extraction.invoice_owned(invoice_id, business.id),
            validation=validation.model_dump(mode="json"),
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND) from error
    except OwnershipConflictError as error:
        # Unreachable through the API because of the ownership check above;
        # kept non-disclosing rather than turning it into a 403 that would
        # confirm the record exists.
        raise HTTPException(status_code=404, detail=DOCUMENT_NOT_FOUND) from error
    except DocumentQuarantinedError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/{document_id}/audit", response_model=list[AuditEvent])
def get_document_audit(
    document_id: str,
    business: BusinessRecord = Depends(get_active_business),
) -> list[AuditEvent]:
    owned_document(document_id, business)
    return audit.list_for_document(document_id, business_id=business.id)
