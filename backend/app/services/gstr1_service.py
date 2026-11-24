from app.schemas.gstr1 import GSTR1LineItem, GSTR1Record
from app.schemas.invoice import CanonicalInvoice
from app.validators.r10_bucket import classify

BUCKET_TO_INVOICE_TYPE = {
    "b2b": "B2B",
    "b2cl": "B2CL",
    "b2cs": "B2CS",
}


class GSTR1Service:
    """Builds the internal GSTR-1 representation from an extracted invoice.

    Values are copied from the canonical invoice. Nothing is recalculated,
    inferred, or fetched from Gemini; the validation engine stays authoritative
    for compliance and export readiness.
    """

    def build_record(self, invoice: CanonicalInvoice) -> GSTR1Record:
        if invoice.invoice_date is None:
            raise ValueError(
                "GSTR1 record requires invoice_date; the canonical invoice has no date."
            )

        bucket = classify(invoice)
        invoice_type = BUCKET_TO_INVOICE_TYPE.get(bucket)

        if invoice_type is None:
            raise ValueError(f"Unsupported GSTR-1 bucket: {bucket}")

        return GSTR1Record(
            invoice_number=invoice.invoice_number,
            invoice_date=invoice.invoice_date,
            invoice_type=invoice_type,
            supplier_gstin=invoice.supplier.gstin,
            buyer_gstin=invoice.buyer.gstin,
            place_of_supply_state_code=invoice.place_of_supply_state_code,
            reverse_charge=invoice.reverse_charge,
            taxable_value=invoice.totals.taxable_value,
            cgst_total=invoice.totals.cgst_total,
            sgst_total=invoice.totals.sgst_total,
            igst_total=invoice.totals.igst_total,
            cess_total=invoice.totals.cess_total,
            grand_total=invoice.totals.grand_total,
            line_items=[
                GSTR1LineItem(
                    description=line.description,
                    hsn_sac=line.hsn_sac,
                    quantity=line.quantity,
                    taxable_value=line.taxable_value,
                    gst_rate_pct=line.gst_rate_pct,
                    cgst_amount=line.cgst_amount,
                    sgst_amount=line.sgst_amount,
                    igst_amount=line.igst_amount,
                    cess_amount=line.cess_amount,
                )
                for line in invoice.line_items
            ],
        )
