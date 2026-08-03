from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser

router = APIRouter(prefix="/teams", tags=["teams"])


class CreateTeamRequest(BaseModel):
    tenant_id: str
    name: str


class AddMemberRequest(BaseModel):
    user_id: str


@router.get("")
async def list_teams(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """Teams the caller can see. No manual tenant filter — RLS scopes it."""
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT t.id, t.name, t.tenant_id, o.name AS tenant_name,
                   (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count
            FROM teams t
            JOIN organizations o ON o.id = t.tenant_id
            WHERE ($1::uuid IS NULL OR t.tenant_id = $1::uuid)
            ORDER BY o.name, t.name
            """,
            target_tenant,
        )
    return [dict(r) for r in rows]


@router.post("")
async def create_team(body: CreateTeamRequest, current_user: CurrentUser = Depends(get_current_user)):
    """
    Create a team inside a tenant. No app-layer admin gate needed: RLS's
    WITH CHECK refuses the insert unless the caller actually has access to
    that tenant, so a PortCo lead can make their own teams too.
    """
    async with get_scoped_connection(current_user.user_id) as conn:
        try:
            row = await conn.fetchrow(
                "INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id, name, tenant_id",
                body.tenant_id, body.name,
            )
        except Exception:
            raise HTTPException(status_code=403, detail="You don't have access to that tenant")
        if row is None:
            raise HTTPException(status_code=403, detail="You don't have access to that tenant")
    return dict(row)


@router.get("/{team_id}/members")
async def list_members(team_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT tm.id, tm.user_id, u.name, u.email
            FROM team_members tm
            JOIN users u ON u.id = tm.user_id
            WHERE tm.team_id = $1
            ORDER BY u.name
            """,
            team_id,
        )
    return [dict(r) for r in rows]


@router.post("/{team_id}/members")
async def add_member(team_id: str, body: AddMemberRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Add a user to a team. The team's tenant_id is copied onto the row so
    the uniform tenant-isolation policy applies."""
    async with get_scoped_connection(current_user.user_id) as conn:
        # RLS on `teams` guarantees we only find a team we're allowed to touch
        team = await conn.fetchrow("SELECT tenant_id FROM teams WHERE id = $1", team_id)
        if team is None:
            raise HTTPException(status_code=404, detail="Team not found or not accessible")
        try:
            row = await conn.fetchrow(
                """
                INSERT INTO team_members (tenant_id, team_id, user_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (team_id, user_id) DO NOTHING
                RETURNING id
                """,
                team["tenant_id"], team_id, body.user_id,
            )
        except Exception:
            raise HTTPException(status_code=400, detail="Could not add member")
    return {"added": row is not None, "already_member": row is None}


@router.delete("/{team_id}/members/{user_id}")
async def remove_member(team_id: str, user_id: str, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        result = await conn.execute(
            "DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", team_id, user_id
        )
    return {"deleted": result}
