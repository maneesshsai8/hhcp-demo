from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.security import hash_password

router = APIRouter(prefix="/users", tags=["users"])


class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str
    is_fund_admin: bool = False


async def _require_fund_admin(conn, user_id: str):
    is_admin = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM fund_roles WHERE user_id = $1 AND role = 'fund_admin')", user_id
    )
    if not is_admin:
        raise HTTPException(status_code=403, detail="Only Hidden Harbor fund admins can do this")


@router.get("")
async def list_users(current_user: CurrentUser = Depends(get_current_user)):
    """
    Admin-only directory. `users` has no RLS (identity isn't tenant-scoped),
    so we gate this at the app layer instead.
    """
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_admin(conn, current_user.user_id)
        rows = await conn.fetch(
            """
            SELECT u.id, u.name, u.email,
                   EXISTS (SELECT 1 FROM fund_roles fr WHERE fr.user_id = u.id AND fr.role = 'fund_admin') AS is_fund_admin,
                   (SELECT count(*) FROM tenant_memberships tm WHERE tm.user_id = u.id) AS grant_count
            FROM users u
            ORDER BY u.name
            """
        )
    return [dict(r) for r in rows]


@router.post("")
async def create_user(body: CreateUserRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Create a login. Admin only. Password is bcrypt-hashed before storage."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await _require_fund_admin(conn, current_user.user_id)

        exists = await conn.fetchval("SELECT 1 FROM users WHERE email = $1", body.email)
        if exists:
            raise HTTPException(status_code=409, detail="A user with that email already exists")

        row = await conn.fetchrow(
            "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
            body.name, body.email, hash_password(body.password),
        )
        if body.is_fund_admin:
            await conn.execute(
                "INSERT INTO fund_roles (user_id, role) VALUES ($1, 'fund_admin') ON CONFLICT DO NOTHING",
                row["id"],
            )
    return {**dict(row), "is_fund_admin": body.is_fund_admin}
