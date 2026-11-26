from datetime import datetime

from pydantic import BaseModel, Field


class BusinessResponse(BaseModel):
    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    is_active: bool


class BusinessCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class MembershipResponse(BaseModel):
    id: str
    user_id: str
    business_id: str
    role: str
    created_at: datetime
