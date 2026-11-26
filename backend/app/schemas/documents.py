from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.invoice import CanonicalInvoice


class DocumentRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: str
    filename: str
    media_type: str
    extension: str
    size_bytes: int
    sha256: str
    status: Literal["uploaded", "extracted", "quarantined", "failed"]
    created_at: datetime
    invoice_id: str | None = None
    # Owning business. `None` marks a legacy record created before business
    # ownership existed; it is never assigned an owner retroactively.
    business_id: str | None = None
    security_notes: list[str] = Field(default_factory=list)


class ExtractResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: DocumentRecord
    invoice_id: str
    invoice: CanonicalInvoice
    validation: dict