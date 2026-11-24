from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from PIL import Image

from app.core.config import settings
from app.core.file_security import read_and_validate, server_filename, suspicious_text
from app.schemas.documents import DocumentRecord
from app.services.audit_service import AuditService, record_safely


class DocumentService:
    """Private-storage adapter for the milestone; Supabase Storage replaces the local adapter next."""

    def __init__(self, audit: AuditService | None = None) -> None:
        self.audit = audit
        self._documents: dict[str, DocumentRecord] = {}
        self._paths: dict[str, Path] = {}
        self._root = Path(settings.storage_root)
        self._metadata_path = self._root.parent / "documents.json"
        self._load_metadata()

    async def upload(self, upload: UploadFile) -> DocumentRecord:
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
        record = DocumentRecord(document_id=document_id, filename=upload.filename or "document", media_type=media_type, extension=extension, size_bytes=len(data), sha256=digest, status=status, created_at=datetime.now(timezone.utc), security_notes=notes)
        self._documents[document_id] = record
        self._paths[document_id] = path
        self._persist_metadata()
        record_safely(
            self.audit,
            event_type="document_uploaded",
            status="completed",
            message="Document uploaded and stored under a server-generated name.",
            document_id=document_id,
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
            metadata={"security_notes": ", ".join(notes)} if notes else None,
        )
        return record

    def get(self, document_id: str) -> DocumentRecord:
        if document_id not in self._documents:
            self._load_metadata()
        if document_id not in self._documents:
            raise KeyError(document_id)
        return self._documents[document_id]

    def bytes_for(self, document_id: str) -> bytes:
        self.get(document_id)
        return self._paths[document_id].read_bytes()

    def find_by_invoice(self, invoice_id: str) -> str | None:
        for document_id, record in self._documents.items():
            if record.invoice_id == invoice_id:
                return document_id
        return None

    def mark(self, document_id: str, **changes: object) -> DocumentRecord:
        current = self.get(document_id)
        updated = current.model_copy(update=changes)
        self._documents[document_id] = updated
        self._persist_metadata()
        return updated

    def _load_metadata(self) -> None:
        if not self._metadata_path.exists():
            return
        with self._metadata_path.open("r", encoding="utf-8") as metadata_file:
            payload = json.load(metadata_file)
        for document_id, entry in payload.items():
            record = DocumentRecord.model_validate(entry["record"])
            self._documents[document_id] = record
            self._paths[document_id] = Path(entry["storage_path"])

    def _persist_metadata(self) -> None:
        self._metadata_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            document_id: {
                "record": record.model_dump(mode="json"),
                "storage_path": str(self._paths[document_id]),
            }
            for document_id, record in self._documents.items()
        }
        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self._metadata_path.parent,
                prefix=".documents-",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = temporary_file.name
                json.dump(payload, temporary_file, ensure_ascii=False, indent=2)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            Path(temporary_path).replace(self._metadata_path)
        finally:
            if temporary_path and Path(temporary_path).exists():
                Path(temporary_path).unlink()

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
