from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/seats", tags=["accountability-chart"])


class NewSeatRequest(BaseModel):
    tenant_id: str
    title: str
    holder_user_id: str | None = None
    parent_seat_id: str | None = None
    responsibilities: str | None = None


class UpdateSeatRequest(BaseModel):
    title: str | None = None
    holder_user_id: str | None = None
    parent_seat_id: str | None = None
    responsibilities: str | None = None


@router.get("")
async def list_seats(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """The Accountability Chart for a tenant — a flat list the UI renders as a tree."""
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT s.id, s.title, s.parent_seat_id, s.responsibilities, s.tenant_id,
                   s.holder_user_id, u.name AS holder_name
            FROM seats s
            LEFT JOIN users u ON u.id = s.holder_user_id
            WHERE ($1::uuid IS NULL OR s.tenant_id = $1::uuid)
            ORDER BY s.created_at
            """,
            target_tenant,
        )
    return [dict(r) for r in rows]


@router.post("")
async def create_seat(body: NewSeatRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO seats (tenant_id, title, holder_user_id, parent_seat_id, responsibilities)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, title, parent_seat_id, tenant_id
            """,
            body.tenant_id, body.title, body.holder_user_id, body.parent_seat_id, body.responsibilities,
        )
    return dict(row)


@router.patch("/{seat_id}")
async def update_seat(seat_id: str, body: UpdateSeatRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        row = await conn.fetchrow(
            """
            UPDATE seats SET
                title = COALESCE($2, title),
                holder_user_id = COALESCE($3, holder_user_id),
                parent_seat_id = COALESCE($4, parent_seat_id),
                responsibilities = COALESCE($5, responsibilities)
            WHERE id = $1
            RETURNING id, title, tenant_id
            """,
            seat_id, body.title, body.holder_user_id, body.parent_seat_id, body.responsibilities,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Seat not found or not accessible")
    return dict(row)


@router.delete("/{seat_id}")
async def delete_seat(seat_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Deleting a seat cascades to seats reporting under it (FK ON DELETE CASCADE)."""
    async with get_scoped_connection(current_user.user_id) as conn:
        result = await conn.execute("DELETE FROM seats WHERE id = $1", seat_id)
    return {"deleted": result}
