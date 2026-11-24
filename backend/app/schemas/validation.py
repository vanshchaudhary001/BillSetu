from typing import Literal

from pydantic import BaseModel, ConfigDict


class ValidationIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rule_id: str
    severity: Literal["advisory", "warning", "error", "critical"]
    field_path: str
    message_en: str
    message_hi: str
    suggested_value: str | None = None
    legal_ref: str | None = None


class FieldConfidence(BaseModel):
    field_path: str
    score: float
    band: Literal["high", "medium", "low"]
    signals: dict[str, float]


class ComplianceSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    headline: str
    message: str
    action_required: bool
    issue_count: int
    error_count: int
    warning_count: int


class ValidationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["validated", "review_required", "blocked"]
    gstr1_bucket: Literal["b2b", "b2cl", "b2cs"] | None = None
    fingerprint: str
    issues: list[ValidationIssue]
    confidence: list[FieldConfidence]
    export_ready: bool
    summary: ComplianceSummary