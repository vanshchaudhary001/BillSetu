from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from PIL import Image

from app.core.config import settings
from app.core.file_security import read_and_validate, server_filename, suspicious_text
from app.schemas.documents import DocumentRecord
from app.services.audit_service import AuditService, record_safely
from app.storage.json_store import read_json, write_json_atomic


class DocumentService:
    """Private-storage adapter for the milestone; Supabase Storage replaces the local adapter next.

    Every record carries the `business_id` of the business that created it.
    `business_id = None` marks a legacy record and is treated as inaccessible by
    the business-scoped lookups below, which is the only path routes use.
    """

    def __init__(self, audit: AuditService | None = None) -> None:
        self.audit = audit
        self._documents: dict[str, DocumentRecord] = {}
        self._paths: dict[str, Path] = {}
        self._root = Path(settings.storage_root)
        self._metadata_path = self._root.parent / "documents.json"
        self._load_metadata()

    async def upload(
        self, upload: UploadFile, business_id: str | None = None
    ) -> DocumentRecord:
        # Ownership is passed in by the route from the authenticated session; a
        # request body can never choose the owner.
        owner_id = business_id
        data, media_type, extension, digest, notes = await read_and_validate(upload)
        if media_type.startswith("image/"):
            try:
                data, image_notes = self._normalize_image(data)
            except Exception as error:
                raise HTTPException(
                    status_code=422,
                    detail="Image contents could not be decoded",
                ) from error
            notes.extend(image_notes)
            # Normalization always emits JPEG, so the stored identifier and
            # media type must describe the sanitized bytes, not the upload.
            extension = ".jpg"
            media_type = "image/jpeg"
        elif media_type == "application/pdf":
            try:
                notes.extend(self._inspect_pdf(data))
            except Exception as error:
                raise HTTPException(
                    status_code=422,
                    detail="PDF contents could not be parsed",
                ) from error
        document_id = str(uuid4())
        path = self._root / server_filename(extension)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        status = "quarantined" if "suspicious_instruction_text_detected" in notes else "uploaded"
        record = DocumentRecord(document_id=document_id, filename=upload.filename or "document", media_type=media_type, extension=extension, size_bytes=len(data), sha256=digest, status=status, created_at=datetime.now(timezone.utc), business_id=owner_id, security_notes=notes)
        self._documents[document_id] = record
        self._paths[document_id] = path
        self._persist_metadata()
        record_safely(
            self.audit,
            event_type="document_uploaded",
            status="completed",
            message="Document uploaded and stored under a server-generated name.",
            document_id=document_id,
            business_id=owner_id,
            metadata={
                "media_type": media_type,
                "size_bytes": len(data),
                "sha256": digest,
            },
        )
        record_safely(
            self.audit,
            event_type="security_checked",
            status="blocked" if status == "quarantined" else "completed",
            message=(
                "Security checks quarantined the document."
                if status == "quarantined"
                else "Security checks completed."
            ),
            document_id=document_id,
            business_id=owner_id,
            metadata={"security_notes": ", ".join(notes)} if notes else None,
        )
        return record

    def get(self, document_id: str) -> DocumentRecord:
        record = self._record(document_id)
        if record is None:
            raise KeyError(document_id)
        return record

    def get_owned(self, document_id: str, business_id: str) -> DocumentRecord:
        """Business-scoped lookup: id and owner are resolved as one operation.

        A missing document, a legacy unowned document and a document owned by
        another business all raise the same `KeyError`, so callers cannot tell
        them apart and existence is never disclosed before authorization.
        """
        record = self._record(document_id)
        if record is None or not business_id or record.business_id != business_id:
            raise KeyError(document_id)
        return record

    def list_owned(self, business_id: str) -> list[DocumentRecord]:
        """Documents owned by `business_id`; legacy unowned records are excluded."""
        if not business_id:
            return []
        if not self._documents:
            self._load_metadata()
        return sorted(
            (
                record
                for record in self._documents.values()
                if record.business_id == business_id
            ),
            key=lambda record: (record.created_at, record.document_id),
        )

    def bytes_for(self, document_id: str) -> bytes:
        self.get(document_id)
        return self._paths[document_id].read_bytes()

    def bytes_for_owned(self, document_id: str, business_id: str) -> bytes:
        """Authorize against the record before any bytes are read from disk."""
        self.get_owned(document_id, business_id)
        return self._paths[document_id].read_bytes()

    def business_id_for(self, document_id: str) -> str | None:
        """Owning business of a stored document, or None for a legacy record."""
        return self.get(document_id).business_id

    def find_by_invoice(
        self, invoice_id: str, business_id: str | None = None
    ) -> str | None:
        """Document linked to an invoice, optionally restricted to one owner."""
        for document_id, record in self._documents.items():
            if record.invoice_id != invoice_id:
                continue
            if business_id is not None and record.business_id != business_id:
                continue
            return document_id
        return None

    def mark(self, document_id: str, **changes: object) -> DocumentRecord:
        current = self.get(document_id)
        updated = current.model_copy(update=changes)
        self._documents[document_id] = updated
        self._persist_metadata()
        return updated

    def _record(self, document_id: str) -> DocumentRecord | None:
        if document_id not in self._documents:
            self._load_metadata()
        return self._documents.get(document_id)

    def _load_metadata(self) -> None:
        payload = read_json(self._metadata_path, {})
        for document_id, entry in payload.items():
            record = DocumentRecord.model_validate(entry["record"])
            self._documents[document_id] = record
            self._paths[document_id] = Path(entry["storage_path"])

    def _persist_metadata(self) -> None:
        payload = {
            document_id: {
                "record": record.model_dump(mode="json"),
                "storage_path": str(self._paths[document_id]),
            }
            for document_id, record in self._documents.items()
        }
        write_json_atomic(self._metadata_path, payload)

    @staticmethod
    def _normalize_image(data: bytes) -> tuple[bytes, list[str]]:
        from io import BytesIO
        source = Image.open(BytesIO(data))
        source.verify()
        image = Image.open(BytesIO(data)).convert("RGB")
        output = BytesIO()
        image.save(output, format="JPEG", quality=92, optimize=True)
        return output.getvalue(), ["image_decoded_reencoded", "exif_removed"]

    @staticmethod
    def _inspect_pdf(data: bytes) -> list[str]:
        import pdfplumber
        from io import BytesIO
        with pdfplumber.open(BytesIO(data)) as pdf:
            text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        return ["suspicious_instruction_text_detected"] if suspicious_text(text) else []
