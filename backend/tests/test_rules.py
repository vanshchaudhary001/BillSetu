from datetime import date
from decimal import Decimal

from app.schemas.invoice import InvoiceValidationRequest, Party
from app.services.validation_engine import ValidationEngine
from app.validators.r01_gstin import _checksum


def test_clean_invoice_validates(clean_invoice):
    result = ValidationEngine().validate(clean_invoice)
    assert result.status == "validated"
    assert result.export_ready is True
    assert result.gstr1_bucket == "b2b"


def test_invalid_gstin_and_ocr_repair_are_reported(clean_invoice):
    clean_invoice.buyer.gstin = clean_invoice.supplier.gstin[:12] + "I" + clean_invoice.supplier.gstin[13:]
    result = ValidationEngine().validate(clean_invoice)
    issue = next(item for item in result.issues if item.rule_id == "R01" and item.field_path == "buyer.gstin")
    assert issue.suggested_value is not None


def test_wrong_total_is_blocked(clean_invoice):
    clean_invoice.totals.grand_total = Decimal("52500")
    result = ValidationEngine().validate(clean_invoice)
    assert any(item.rule_id == "R03" for item in result.issues)
    assert result.export_ready is False

def test_matching_grand_total_does_not_trigger_r03(clean_invoice):
    clean_invoice.totals.taxable_value = Decimal("18000")
    clean_invoice.totals.cgst_total = Decimal("1620")
    clean_invoice.totals.sgst_total = Decimal("1620")
    clean_invoice.totals.igst_total = Decimal("0")
    clean_invoice.totals.cess_total = Decimal("0")
    clean_invoice.totals.round_off = Decimal("0")
    clean_invoice.totals.grand_total = Decimal("21240")

    result = ValidationEngine().validate(clean_invoice)

    assert not any(
        item.rule_id == "R03" and item.field_path == "totals.grand_total"
        for item in result.issues
    )

def test_wrong_tax_split_is_blocked(clean_invoice):
    clean_invoice.totals.igst_total = Decimal("8100")
    clean_invoice.totals.cgst_total = Decimal("0")
    clean_invoice.totals.sgst_total = Decimal("0")
    result = ValidationEngine().validate(clean_invoice)
    assert any(item.rule_id == "R04" for item in result.issues)


def test_duplicate_is_detected(clean_invoice):
    result = ValidationEngine().validate(clean_invoice, [__import__('app.validators.common', fromlist=['fingerprint']).fingerprint(clean_invoice)])
    assert any(item.rule_id == "R09" for item in result.issues)


def test_legacy_rate_and_missing_mandatory_field_are_reported(clean_invoice):
    clean_invoice.line_items[0].gst_rate_pct = Decimal("12")
    clean_invoice.supplier.name = None
    result = ValidationEngine().validate(clean_invoice)
    assert any(item.rule_id == "R05" for item in result.issues)
    assert any(item.rule_id == "R07" for item in result.issues)


def test_unreadable_and_prompt_injection_are_quarantined(clean_invoice):
    clean_invoice.document_type = "unreadable"
    clean_invoice.suspicious_instruction_text_detected = True
    result = ValidationEngine().validate(clean_invoice)
    assert result.status == "blocked"
    assert {item.rule_id for item in result.issues} >= {"R12"}


def test_composition_guard(clean_invoice):
    result = ValidationEngine().validate(clean_invoice, business_scheme="composition")
    assert any(item.rule_id == "R11" for item in result.issues)

def test_b2b_bucket(clean_invoice):
    clean_invoice.buyer.gstin = "07AABCT5678D1Z3"

    result = ValidationEngine().validate(clean_invoice)

    assert result.gstr1_bucket == "b2b"


def test_b2cl_bucket(clean_invoice):
    clean_invoice.buyer.gstin = None
    clean_invoice.supplier.state_code = "07"
    clean_invoice.place_of_supply_state_code = "09"
    clean_invoice.totals.grand_total = Decimal("100001")

    result = ValidationEngine().validate(clean_invoice)

    assert result.gstr1_bucket == "b2cl"


def test_b2cs_bucket(clean_invoice):
    clean_invoice.buyer.gstin = None
    clean_invoice.supplier.state_code = "07"
    clean_invoice.place_of_supply_state_code = "09"
    clean_invoice.totals.grand_total = Decimal("100000")

    result = ValidationEngine().validate(clean_invoice)

    assert result.gstr1_bucket == "b2cs"