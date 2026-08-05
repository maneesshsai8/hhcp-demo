import csv
import io
import re

from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.security import hash_password
from app import audit

router = APIRouter(prefix="/users", tags=["users"])


def _validate_password(pw: str):
    """Secure password policy: >= 8 chars, with a letter, a number, and a symbol."""
    if (len(pw) < 8 or not re.search(r"[A-Za-z]", pw) or not re.search(r"\d", pw)
            or not re.search(r"[^A-Za-z0-9]", pw)):
        raise HTTPException(
            status_code=422,
            detail="Password must be at least 8 characters and include a letter, a number, and a symbol.",
        )


class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str
    is_fund_admin: bool = False
    is_fund_viewer: bool = False
    title: str | None = None
    department: str | None = None
    reports_to: str | None = None


class UpdateUserRequest(BaseModel):
    name: str | None = None
    title: str | None = None
    department: str | None = None
    is_active: bool | None = None
    reports_to: str | None = None


class ImportUsersRequest(BaseModel):
    csv: str  # header row: name,email,title,department


async def _require_fund_admin(conn, user_id: str):
    is_admin = await conn.fetchval(
        "SELECT COALESCE(is_fund_admin, false) FROM users WHERE id = $1", user_id
    )
    if not is_admin:
        raise HTTPException(status_code=403, detail="Only Hidden Harbor fund admins can do this")


async def _require_fund_view(conn, user_id: str):
    """Read access: fund admins OR fund viewers."""
    ok = await conn.fetchval(
        "SELECT COALESCE(is_fund_admin, false) OR COALESCE(is_fund_viewer, false) FROM users WHERE id = $1",
        user_id,
    )
    if not ok:
        raise HTTPException(status_code=403, detail="Fund-level access required")


@router.get("")
async def list_users(active_only: bool = Query(default=False), current_user: CurrentUser = Depends(get_current_user)):
    """Fund-level employee directory. `users` has no RLS, so gate at the app layer.
    Fund viewers can read it; only admins can mutate."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_view(conn, current_user.user_id)
        rows = await conn.fetch(
            f"""
            SELECT u.id, u.name, u.email, u.is_fund_admin, u.is_fund_viewer, u.title, u.department, u.is_active,
                   (SELECT name FROM users m WHERE m.id = u.reports_to) AS reports_to_name,
                   (SELECT count(*) FROM tenant_memberships tm WHERE tm.user_id = u.id) AS grant_count,
                   (SELECT count(*) FROM team_members tmb WHERE tmb.user_id = u.id) AS team_count
            FROM users u
            {"WHERE u.is_active" if active_only else ""}
            ORDER BY u.name
            """
        )
    return [dict(r) for r in rows]


@router.post("")
async def create_user(body: CreateUserRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Create a login. Admin only. Password is bcrypt-hashed before storage."""
    _validate_password(body.password)
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_admin(conn, current_user.user_id)
        if await conn.fetchval("SELECT 1 FROM users WHERE email = $1", body.email):
            raise HTTPException(status_code=409, detail="A user with that email already exists")
        row = await conn.fetchrow(
            """
            INSERT INTO users (name, email, password_hash, is_fund_admin, is_fund_viewer, title, department, reports_to)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, email
            """,
            body.name, body.email, hash_password(body.password), body.is_fund_admin,
            body.is_fund_viewer, body.title, body.department, body.reports_to,
        )
        await audit.log(conn, current_user.user_id, "user.create", entity_type="user",
                        entity_id=row["id"], detail=f"{body.name} <{body.email}>")
    return {**dict(row), "is_fund_admin": body.is_fund_admin}


@router.patch("/{user_id}")
async def update_user(user_id: str, body: UpdateUserRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Edit directory fields / activate / deactivate. Admin only."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_admin(conn, current_user.user_id)
        row = await conn.fetchrow(
            """
            UPDATE users SET
                name       = COALESCE($2, name),
                title      = COALESCE($3, title),
                department = COALESCE($4, department),
                is_active  = COALESCE($5, is_active),
                reports_to = COALESCE($6, reports_to)
            WHERE id = $1
            RETURNING id, name, email, is_active
            """,
            user_id, body.name, body.title, body.department, body.is_active, body.reports_to,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        if body.is_active is not None:
            action = "user.activate" if body.is_active else "user.deactivate"
            await audit.log(conn, current_user.user_id, action, entity_type="user",
                            entity_id=row["id"], detail=row["name"])
        else:
            await audit.log(conn, current_user.user_id, "user.edit", entity_type="user",
                            entity_id=row["id"], detail=row["name"])
    return dict(row)


@router.post("/import")
async def import_users(body: ImportUsersRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Bulk CSV import. Header row: name,email,title,department. Admin only.
    New users get a temporary password and should reset / use SSO."""
    created, skipped = 0, 0
    reader = csv.DictReader(io.StringIO(body.csv.strip()))
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_admin(conn, current_user.user_id)
        for r in reader:
            email = (r.get("email") or "").strip().lower()
            name = (r.get("name") or "").strip()
            if not email or not name:
                continue
            if await conn.fetchval("SELECT 1 FROM users WHERE lower(email) = $1", email):
                skipped += 1
                continue
            await conn.execute(
                "INSERT INTO users (name, email, password_hash, title, department) VALUES ($1, $2, $3, $4, $5)",
                name, email, hash_password("ChangeMe123!"), (r.get("title") or "").strip() or None,
                (r.get("department") or "").strip() or None,
            )
            created += 1
        await audit.log(conn, current_user.user_id, "user.import", detail=f"{created} created, {skipped} skipped")
    return {"created": created, "skipped": skipped}
