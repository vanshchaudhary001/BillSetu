from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class EvidenceField(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str | None = None
    raw_evidence: str = ""
    model_clarity: Literal["high", "medium", "low"] | None = None


class Party(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    gstin: str | None = None
    state_code: str | None = None
    address_present: bool = False


class LineItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str = ""
    hsn_sac: str | None = None
    quantity: Decimal = Field(default=Decimal("1"), ge=0)
    uqc: str | None = None
    unit_rate: Decimal = Field(default=Decimal("0"), ge=0)
    discount: Decimal = Field(default=Decimal("0"), ge=0)
    taxable_value: Decimal = Field(default=Decimal("0"), ge=0)
    gst_rate_pct: Decimal = Field(default=Decimal("0"), ge=0, le=100)
    cgst_amount: Decimal = Field(default=Decimal("0"), ge=0)
    sgst_amount: Decimal = Field(default=Decimal("0"), ge=0)
    igst_amount: Decimal = Field(default=Decimal("0"), ge=0)
    cess_amount: Decimal = Field(default=Decimal("0"), ge=0)


class InvoiceTotals(BaseModel):
    model_config = ConfigDict(extra="forbid")
    taxable_value: Decimal = Field(default=Decimal("0"), ge=0)
    cgst_total: Decimal = Field(default=Decimal("0"), ge=0)
    sgst_total: Decimal = Field(default=Decimal("0"), ge=0)
    igst_total: Decimal = Field(default=Decimal("0"), ge=0)
    cess_total: Decimal = Field(default=Decimal("0"), ge=0)
    round_off: Decimal = Decimal("0")
    grand_total: Decimal = Field(default=Decimal("0"), ge=0)


class CanonicalInvoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_type: Literal["tax_invoice", "bill_of_supply", "cash_memo", "credit_note", "unreadable"] = "tax_invoice"
    transaction_direction: Literal["outward_sale", "inward_purchase"] = "outward_sale"
    invoice_number: str = ""
    invoice_date: date | None = None
    supplier: Party = Field(default_factory=Party)
    buyer: Party = Field(default_factory=Party)
    place_of_supply_state_code: str | None = None
    reverse_charge: bool = False
    composition_declaration_detected: bool = False
    line_items: list[LineItem] = Field(default_factory=list)
    totals: InvoiceTotals = Field(default_factory=InvoiceTotals)
    document_quality_notes: list[str] = Field(default_factory=list)
    suspicious_instruction_text_detected: bool = False
    image_sharpness: Decimal | None = Field(default=None, ge=0, le=1)

    @field_validator("supplier", "buyer", mode="before")
    @classmethod
    def normalize_party(cls, value: Party | None) -> Party | None:
        return value


class InvoiceSummary(BaseModel):
    """One row of the business-scoped invoice list.

    A read model derived from `CanonicalInvoice`, so the canonical invoice
    contract itself is unchanged. It carries invoice-header facts only: enough
    for the workspace list and its totals without shipping a full invoice
    payload per row or forcing a request per invoice.
    """

    model_config = ConfigDict(extra="forbid")
    invoice_id: str
    invoice_number: str = ""
    invoice_date: date | None = None
    transaction_direction: Literal["outward_sale", "inward_purchase"] = "outward_sale"
    supplier_name: str | None = None
    buyer_name: str | None = None
    buyer_gstin: str | None = None
    place_of_supply_state_code: str | None = None
    taxable_value: Decimal = Field(default=Decimal("0"), ge=0)
    cgst_total: Decimal = Field(default=Decimal("0"), ge=0)
    sgst_total: Decimal = Field(default=Decimal("0"), ge=0)
    igst_total: Decimal = Field(default=Decimal("0"), ge=0)
    cess_total: Decimal = Field(default=Decimal("0"), ge=0)
    grand_total: Decimal = Field(default=Decimal("0"), ge=0)
    document_id: str | None = None


class InvoiceValidationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invoice: CanonicalInvoice
    business_scheme: Literal["regular", "composition"] = "regular"
    annual_turnover: Decimal = Field(default=Decimal("5000000"), ge=0)
    filing_period: str | None = None
    existing_fingerprints: list[str] = Field(default_factory=list)
