from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


AuditEventType = Literal[
    "document_uploaded",
    "security_checked",
    "extraction_started",
    "extraction_completed",
    "extraction_failed",
    "validation_completed",
    "gstr1_generated",
    "export_json_generated",
    "export_csv_generated",
]

AuditEventStatus = Literal[
    "started",
    "completed",
    "failed",
    "blocked",
    "review_required",
]


class AuditEvent(BaseModel):
    """One internal processing step for a document or invoice.

    This is a prototype-scale processing history, not a legal audit log.
    Metadata is restricted to JSON scalars so raw document contents and
    credentials cannot be stored by accident.
    """

    model_config = ConfigDict(extra="forbid")
    event_id: str
    document_id: str
    invoice_id: str | None = None
    event_type: AuditEventType
    status: AuditEventStatus
    message: str
    created_at: datetime
    # Owning business. `None` marks a legacy event recorded before business
    # ownership existed; legacy events are never reassigned.
    business_id: str | None = None
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
