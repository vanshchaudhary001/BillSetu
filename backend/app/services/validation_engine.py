from app.schemas.invoice import CanonicalInvoice
from app.schemas.validation import ComplianceSummary, ValidationResponse
from app.services.confidence import calculate
from app.validators.common import all_issues, fingerprint
from app.validators import (
    r01_gstin,
    r02_line_arithmetic,
    r03_grand_total,
    r04_tax_split,
    r05_slab_drift,
    r06_serial,
    r07_rule46,
    r08_hsn,
    r09_duplicate,
    r10_bucket,
    r11_composition,
    r12_quarantine,
)


class ValidationEngine:
    def validate(
        self,
        invoice: CanonicalInvoice,
        existing_fingerprints: list[str] | None = None,
        business_scheme: str = "regular",
        annual_turnover: object = 5000000,
    ) -> ValidationResponse:
        existing_fingerprints = existing_fingerprints or []

        results = all_issues(
            [
                r01_gstin.validate(invoice),
                r02_line_arithmetic.validate(invoice),
                r03_grand_total.validate(invoice),
                r04_tax_split.validate(invoice),
                r05_slab_drift.validate(invoice),
                r06_serial.validate(invoice),
                r07_rule46.validate(invoice),
                r08_hsn.validate(invoice, str(annual_turnover)),
                r09_duplicate.validate(invoice, existing_fingerprints),
                r11_composition.validate(invoice, business_scheme),
                r12_quarantine.validate(invoice),
            ]
        )

        bucket = r10_bucket.classify(invoice)
        confidence = calculate(invoice, results)

        critical = any(item.severity == "critical" for item in results)
        blocking = any(item.severity == "error" for item in results)

        error_count = sum(
            item.severity in {"error", "critical"}
            for item in results
        )

        warning_count = sum(
            item.severity == "warning"
            for item in results
        )

        if critical:
            headline = "Invoice blocked"
            message = "Critical compliance issues require correction before filing."
        elif blocking:
            headline = "Review required"
            message = f"{error_count} compliance issue(s) require attention before filing."
        elif results:
            headline = "Review recommended"
            message = f"{warning_count} warning(s) should be reviewed before filing."
        else:
            headline = "Invoice validated"
            message = "No compliance issues were detected."

        summary = ComplianceSummary(
            headline=headline,
            message=message,
            action_required=bool(results),
            issue_count=len(results),
            error_count=error_count,
            warning_count=warning_count,
        )

        return ValidationResponse(
            status=(
                "blocked"
                if critical
                else "review_required"
                if blocking or results
                else "validated"
            ),
            gstr1_bucket=bucket,
            fingerprint=fingerprint(invoice),
            issues=results,
            confidence=confidence,
            export_ready=not critical and not blocking and not results,
            summary=summary,
        )