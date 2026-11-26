"""On-disk shape of invoice persistence.

Invoices are stored with explicit business ownership next to the canonical
invoice payload so the invoice API contract (`CanonicalInvoice`) stays free of
ownership metadata.

Current layout (schema version 2)::

    {
      "schema_version": 2,
      "records": {
        "<invoice_id>": {"business_id": "..." | null, "invoice": {...}}
      }
    }

Legacy layout (pre Phase 8B-5) was a plain mapping of invoice id to invoice::

    {"<invoice_id>": {...}}

`parse_invoice_payload` accepts both shapes, so a process that starts before
the migration runs still reads existing data. Legacy entries are returned with
`business_id = None`, which is the explicit "unowned legacy record" marker.
"""

from __future__ import annotations

from typing import Any

SCHEMA_VERSION = 2


def parse_invoice_payload(payload: Any) -> dict[str, dict[str, Any]]:
    """Normalise any supported on-disk invoice payload to owned entries."""
    if isinstance(payload, dict) and isinstance(payload.get("records"), dict):
        records: dict[str, dict[str, Any]] = {}
        for invoice_id, entry in payload["records"].items():
            if not isinstance(entry, dict) or "invoice" not in entry:
                raise ValueError(f"Malformed invoice record for {invoice_id!r}")
            business_id = entry.get("business_id")
            records[str(invoice_id)] = {
                "business_id": business_id if business_id is not None else None,
                "invoice": entry["invoice"],
            }
        return records
    if not isinstance(payload, dict):
        raise ValueError("Invoice persistence must contain an object")
    # Legacy: the mapping values are canonical invoices without ownership.
    return {
        str(invoice_id): {"business_id": None, "invoice": entry}
        for invoice_id, entry in payload.items()
    }


def build_invoice_payload(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Serialise owned invoice entries in the versioned envelope shape."""
    return {
        "schema_version": SCHEMA_VERSION,
        "records": {
            invoice_id: {
                "business_id": entry["business_id"],
                "invoice": entry["invoice"],
            }
            for invoice_id, entry in sorted(records.items())
        },
    }
