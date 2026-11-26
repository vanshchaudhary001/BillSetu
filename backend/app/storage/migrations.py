"""Deterministic, idempotent migration of the JSON application records.

Phase 8B-5 introduced explicit business ownership for invoices, documents and
audit events. Records written before this phase have no owner. The migration
never guesses an owner:

* legacy invoice payloads are wrapped in the owned envelope with
  `business_id = null`;
* document metadata and audit events get an explicit `"business_id": null`;
* the original file is copied to `<name>.pre-ownership.bak` before its first
  rewrite;
* a `storage_schema.json` marker records the applied schema version.

Running the migration again is a no-op: the formats it produces are already the
expected shape, so nothing is rewritten and no record is duplicated. The marker
is informational only — format detection, not the marker, drives the work.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.storage.invoice_records import (
    SCHEMA_VERSION,
    build_invoice_payload,
    parse_invoice_payload,
)
from app.storage.json_store import read_json, write_json_atomic

MARKER_FILENAME = "storage_schema.json"
BACKUP_SUFFIX = ".pre-ownership.bak"
INVOICES_FILENAME = "invoices.json"
DOCUMENTS_FILENAME = "documents.json"
AUDIT_FILENAME = "audit_events.json"


@dataclass(frozen=True)
class MigrationReport:
    data_dir: Path
    applied: bool
    migrated_files: tuple[str, ...]


def storage_data_dir() -> Path:
    """Directory holding the JSON application records for the configured storage."""
    return Path(settings.storage_root).parent


def migrate_persistent_storage(data_dir: Path) -> MigrationReport:
    """Bring JSON records in `data_dir` to the owned-record layout."""
    data_dir = Path(data_dir)
    if not data_dir.exists():
        return MigrationReport(data_dir=data_dir, applied=False, migrated_files=())

    migrated: list[str] = []

    invoices_path = data_dir / INVOICES_FILENAME
    if invoices_path.exists():
        payload = read_json(invoices_path, {})
        if _invoices_need_migration(payload):
            _backup(invoices_path)
            write_json_atomic(
                invoices_path,
                build_invoice_payload(parse_invoice_payload(payload)),
            )
            migrated.append(INVOICES_FILENAME)

    documents_path = data_dir / DOCUMENTS_FILENAME
    if documents_path.exists():
        payload = read_json(documents_path, {})
        if _records_need_ownership(payload, container="record"):
            _backup(documents_path)
            write_json_atomic(documents_path, _normalize_document_payload(payload))
            migrated.append(DOCUMENTS_FILENAME)

    audit_path = data_dir / AUDIT_FILENAME
    if audit_path.exists():
        payload = read_json(audit_path, [])
        if _records_need_ownership(payload):
            _backup(audit_path)
            write_json_atomic(audit_path, _normalize_audit_payload(payload))
            migrated.append(AUDIT_FILENAME)

    if migrated:
        write_json_atomic(
            data_dir / MARKER_FILENAME,
            {
                "schema_version": SCHEMA_VERSION,
                "migrated_at": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
                "migrated_files": migrated,
            },
        )

    return MigrationReport(
        data_dir=data_dir,
        applied=bool(migrated),
        migrated_files=tuple(migrated),
    )


def _backup(path: Path) -> None:
    backup_path = path.with_name(path.name + BACKUP_SUFFIX)
    if not backup_path.exists():
        shutil.copy2(path, backup_path)


def _invoices_need_migration(payload: Any) -> bool:
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        return True
    records = payload.get("records")
    if not isinstance(records, dict):
        return True
    return any(
        not isinstance(entry, dict) or "business_id" not in entry
        for entry in records.values()
    )


def _records_need_ownership(
    payload: Any, *, container: str | None = None
) -> bool:
    if container is not None:
        if not isinstance(payload, dict):
            raise ValueError("Document persistence must contain an object")
        entries = [entry.get(container) for entry in payload.values()]
    else:
        if not isinstance(payload, list):
            raise ValueError("Audit persistence must contain a list")
        entries = payload
    return any(
        not isinstance(entry, dict) or "business_id" not in entry for entry in entries
    )


def _normalize_document_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for document_id in sorted(payload):
        entry = payload[document_id]
        record = entry["record"]
        record.setdefault("business_id", None)
        normalized[document_id] = {
            "record": record,
            "storage_path": entry["storage_path"],
        }
    return normalized


def _normalize_audit_payload(payload: list[Any]) -> list[Any]:
    events: list[Any] = []
    for event in payload:
        event.setdefault("business_id", None)
        events.append(event)
    return events
