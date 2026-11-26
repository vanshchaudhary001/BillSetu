from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.core.config import settings
from app.schemas.audit import AuditEvent, AuditEventStatus, AuditEventType
from app.storage.json_store import read_json, write_json_atomic


class AuditService:
    """Append-only processing history stored beside the existing JSON metadata.

    This is an internal prototype audit trail, not a legal audit log. Audit
    writes are best-effort; callers use `record_safely` so a logging failure
    cannot change or mask the business outcome.

    Every event carries the owning `business_id` when one is known. Events
    created before business ownership existed keep `business_id = None` and are
    never retroactively assigned.
    """

    def __init__(self) -> None:
        self._events: list[AuditEvent] = []
        self._metadata_path = Path(settings.storage_root).parent / "audit_events.json"
        self._load_events()

    def record(
        self,
        *,
        event_type: AuditEventType,
        status: AuditEventStatus,
        message: str,
        document_id: str,
        invoice_id: str | None = None,
        business_id: str | None = None,
        metadata: dict[str, str | int | float | bool | None] | None = None,
    ) -> AuditEvent:
        if self._is_repeat(event_type, status, document_id, invoice_id, business_id):
            return self._events[-1]

        event = AuditEvent(
            event_id=str(uuid4()),
            document_id=document_id,
            invoice_id=invoice_id,
            event_type=event_type,
            status=status,
            message=message,
            created_at=datetime.now(timezone.utc),
            business_id=business_id,
            metadata=metadata or {},
        )
        self._events.append(event)
        self._persist_events()
        return event

    def list_for_document(
        self, document_id: str, business_id: str | None
    ) -> list[AuditEvent]:
        """List a document's audit events in an explicit ownership scope.

        ``None`` remains an intentional way for legacy/internal callers to
        inspect unowned events.  It is deliberately not a default: callers of
        business-owned reads must make their scope explicit.
        """
        return self._ordered(
            event
            for event in self._events
            if event.document_id == document_id
            and event.business_id == business_id
        )

    def list_for_invoice(
        self, invoice_id: str, business_id: str | None
    ) -> list[AuditEvent]:
        """List an invoice's audit events in an explicit ownership scope."""
        return self._ordered(
            event
            for event in self._events
            if event.invoice_id == invoice_id
            and event.business_id == business_id
        )

    def list_for_business(self, business_id: str) -> list[AuditEvent]:
        """Owned events only; legacy events (business_id None) are excluded."""
        return self._ordered(
            event for event in self._events if event.business_id == business_id
        )

    @staticmethod
    def _ordered(events) -> list[AuditEvent]:
        # Stable sort: insertion order is preserved for equal timestamps.
        return sorted(events, key=lambda event: event.created_at)

    def _is_repeat(
        self,
        event_type: AuditEventType,
        status: AuditEventStatus,
        document_id: str,
        invoice_id: str | None,
        business_id: str | None,
    ) -> bool:
        if not self._events:
            return False
        last = self._events[-1]
        return (
            last.event_type == event_type
            and last.status == status
            and last.document_id == document_id
            and last.invoice_id == invoice_id
            and last.business_id == business_id
        )

    def _load_events(self) -> None:
        payload = read_json(self._metadata_path, [])
        for entry in payload:
            self._events.append(AuditEvent.model_validate(entry))

    def _persist_events(self) -> None:
        payload = [event.model_dump(mode="json") for event in self._events]
        write_json_atomic(self._metadata_path, payload)


def record_safely(
    audit: AuditService | None,
    *,
    event_type: AuditEventType,
    status: AuditEventStatus,
    message: str,
    document_id: str,
    invoice_id: str | None = None,
    business_id: str | None = None,
    metadata: dict[str, str | int | float | bool | None] | None = None,
) -> AuditEvent | None:
    """Record an event without letting audit failure affect the workflow."""
    if audit is None:
        return None
    try:
        return audit.record(
            event_type=event_type,
            status=status,
            message=message,
            document_id=document_id,
            invoice_id=invoice_id,
            business_id=business_id,
            metadata=metadata,
        )
    except Exception as error:
        print(f"AUDIT ERROR: {type(error).__name__}: {error}", flush=True)
        return None
