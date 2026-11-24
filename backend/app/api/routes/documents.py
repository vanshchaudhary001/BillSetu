from fastapi import APIRouter, File, HTTPException, Response, UploadFile

from app.schemas.audit import AuditEvent
from app.schemas.documents import DocumentRecord, ExtractResponse
from app.services.audit_service import AuditService
from app.services.document_service import DocumentService
from app.services.extraction_service import DocumentQuarantinedError, ExtractionService
from app.services.gemini_service import GeminiService
from app.services.validation_engine import ValidationEngine

router = APIRouter(prefix="/documents", tags=["documents"])
audit = AuditService()
documents = DocumentService(audit=audit)
extraction = ExtractionService(documents, GeminiService(), ValidationEngine(), audit=audit)


@router.post("/upload", response_model=DocumentRecord, status_code=201)
async def upload_document(file: UploadFile = File(...)) -> DocumentRecord:
    return await documents.upload(file)


@router.get("/{document_id}", response_model=DocumentRecord)
def get_document(document_id: str) -> DocumentRecord:
    try:
        return documents.get(document_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Document not found") from error


@router.get("/{document_id}/content")
def get_document_content(document_id: str) -> Response:
    try:
        record = documents.get(document_id)
        content = documents.bytes_for(document_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Document not found") from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Document content not found") from error

    return Response(
        content=content,
        media_type=record.media_type,
        headers={
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/{document_id}/extract", response_model=ExtractResponse)
def extract_document(document_id: str) -> ExtractResponse:
    try:
        document, invoice_id, validation = extraction.extract(document_id)
        return ExtractResponse(
            document=document,
            invoice_id=invoice_id,
            invoice=extraction.invoice(invoice_id),
            validation=validation.model_dump(mode="json"),
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Document not found") from error
    except DocumentQuarantinedError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/{document_id}/audit", response_model=list[AuditEvent])
def get_document_audit(document_id: str) -> list[AuditEvent]:
    try:
        documents.get(document_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Document not found") from error
    return audit.list_for_document(document_id)
