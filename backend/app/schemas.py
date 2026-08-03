"""
Pydantic response models. Adding these makes the OpenAPI/Swagger docs show the
exact shape of every response (and validates outputs). Nullable DB columns are
Optional so a NULL never trips response validation.

Id fields are typed UUID: asyncpg hands back uuid.UUID objects, and a UUID
field also accepts the pre-stringified ids some endpoints build — both serialize
to JSON strings.
"""
from datetime import date, datetime
from uuid import UUID
from pydantic import BaseModel


# ---- auth ----
class MeUser(BaseModel):
    id: UUID
    name: str
    email: str
    is_fund_admin: bool


class MeTenant(BaseModel):
    id: UUID
    name: str
    tenant_type: str
    parent_tenant_id: UUID | None = None
    role: str | None = None


class MeResponse(BaseModel):
    user: MeUser
    accessible_tenants: list[MeTenant]
    active_tenant_id: UUID | None = None


# ---- organizations / directory / teams / users ----
class Organization(BaseModel):
    id: UUID
    name: str
    tenant_type: str
    parent_tenant_id: UUID | None = None
    fund_label: str | None = None
    acquisition_date: date | None = None
    transaction_type: str | None = None
    exit_date: date | None = None


class Person(BaseModel):
    id: UUID
    name: str
    email: str


class DirectoryUser(Person):
    is_fund_admin: bool | None = None
    grant_count: int | None = None


class Team(BaseModel):
    id: UUID
    name: str
    tenant_id: UUID
    tenant_name: str | None = None
    member_count: int | None = None


# ---- feature modules ----
class WeeklyPoint(BaseModel):
    week_ending: str
    actual_value: float
    status: str


class Scorecard(BaseModel):
    kpi_id: UUID
    title: str
    owner: str | None = None
    target_value: float
    comparison_operator: str
    unit: str | None = None
    tenant_id: UUID
    weekly_history: list[WeeklyPoint]
    off_track_streak: int


class Rock(BaseModel):
    id: UUID
    title: str
    status: str
    due_date: date | None = None
    tenant_id: UUID
    description: str | None = None
    owner_name: str | None = None
    team_name: str | None = None


class Issue(BaseModel):
    id: UUID
    title: str
    description: str | None = None
    status: str
    tenant_id: UUID
    created_at: datetime
    priority: str | None = None
    created_by_name: str | None = None
    team_name: str | None = None


class Todo(BaseModel):
    id: UUID
    title: str
    description: str | None = None
    due_date: date | None = None
    status: str
    is_private: bool
    tenant_id: UUID
    owner_name: str | None = None
    team_name: str | None = None


class Meeting(BaseModel):
    id: UUID
    title: str
    scheduled_at: datetime | None = None
    status: str
    notes: str | None = None
    tenant_id: UUID
    created_by_name: str | None = None
    agenda_key: str | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    rating: float | None = None
    duration_seconds: int | None = None


class Seat(BaseModel):
    id: UUID
    title: str
    parent_seat_id: UUID | None = None
    responsibilities: str | None = None
    tenant_id: UUID
    holder_user_id: UUID | None = None
    holder_name: str | None = None
