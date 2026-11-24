from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class GSTR1LineItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str = ""
    hsn_sac: str | None = None
    quantity: Decimal = Field(default=Decimal("1"), ge=0)
    taxable_value: Decimal = Field(default=Decimal("0"), ge=0)
    gst_rate_pct: Decimal = Field(default=Decimal("0"), ge=0, le=100)
    cgst_amount: Decimal = Field(default=Decimal("0"), ge=0)
    sgst_amount: Decimal = Field(default=Decimal("0"), ge=0)
    igst_amount: Decimal = Field(default=Decimal("0"), ge=0)
    cess_amount: Decimal = Field(default=Decimal("0"), ge=0)


class GSTR1Record(BaseModel):
    """Internal, normalized GSTR-1 view of a canonical invoice.

    This is not an official GST filing payload and does not assert compliance.
    """

    model_config = ConfigDict(extra="forbid")
    invoice_number: str
    invoice_date: date
    invoice_type: Literal["B2B", "B2CL", "B2CS"]
    supplier_gstin: str | None = None
    buyer_gstin: str | None = None
    place_of_supply_state_code: str | None = None
    reverse_charge: bool = False
    taxable_value: Decimal = Field(default=Decimal("0"), ge=0)
    cgst_total: Decimal = Field(default=Decimal("0"), ge=0)
    sgst_total: Decimal = Field(default=Decimal("0"), ge=0)
    igst_total: Decimal = Field(default=Decimal("0"), ge=0)
    cess_total: Decimal = Field(default=Decimal("0"), ge=0)
    grand_total: Decimal = Field(default=Decimal("0"), ge=0)
    line_items: list[GSTR1LineItem] = Field(default_factory=list)
