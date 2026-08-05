"""
Tiny audit-log helper. Every meaningful action (logins, user edits,
deactivations, grants, provisioning) calls log() so the admin audit trail is
complete. audit_log has no RLS — it's a compliance record that deliberately
spans tenants and is only exposed to fund admins via the app.
"""


async def log(conn, actor_id, action, *, entity_type=None, entity_id=None, tenant_id=None, detail=None):
    actor_name = None
    if actor_id:
        actor_name = await conn.fetchval("SELECT name FROM users WHERE id = $1", actor_id)
    await conn.execute(
        """
        INSERT INTO audit_log (actor_id, actor_name, action, entity_type, entity_id, tenant_id, detail)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        actor_id, actor_name, action, entity_type,
        (entity_id if entity_id else None), (tenant_id if tenant_id else None), detail,
    )
