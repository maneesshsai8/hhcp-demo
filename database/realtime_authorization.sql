-- ============================================================================
-- Realtime channel authorization — TENANT ISOLATION ON THE REALTIME LAYER.
--
-- ⚠️  APPLIED TO SUPABASE'S OWN `postgres` DATABASE, *not* hhcp_demo:
--        PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--            -f database/realtime_authorization.sql
--     (Realtime's `realtime.messages` table lives there; our app data lives in
--      hhcp_demo. It is therefore NOT tracked by database/migrate.py, which
--      targets hhcp_demo. On hosted Supabase, apply the same policy via the SQL
--      editor / their migration flow.)
--
-- WHY CLAIMS, NOT A JOIN: a Realtime RLS policy runs in the `postgres` DB and
-- cannot see hhcp_demo's meetings/user_accessible_tenants (no cross-DB queries).
-- So the authorization decision travels IN THE TOKEN: the backend mints a
-- short-lived Realtime JWT whose `app_tenants` claim lists the caller's
-- accessible tenant ids (or `app_fund_admin=true`). Every channel is namespaced
-- `tenant:<tenant_id>:...`, and the policy checks the tenant id parsed from the
-- topic against that claim. No client can subscribe to a tenant it wasn't granted
-- — proven: a token scoped to tenant A gets CHANNEL_ERROR joining tenant B.
--
-- The server still publishes with the service-role key (bypasses RLS), so
-- broadcasts always deliver to authorized subscribers.
-- ============================================================================

-- receive (subscribe): may the caller READ this channel's messages?
DROP POLICY IF EXISTS hhcp_tenant_realtime_read ON realtime.messages;
CREATE POLICY hhcp_tenant_realtime_read ON realtime.messages
    FOR SELECT TO authenticated
    USING (
        coalesce((auth.jwt() -> 'app_fund_admin')::text = 'true', false)
        OR split_part(realtime.topic(), ':', 2) IN (
            SELECT jsonb_array_elements_text(coalesce(auth.jwt() -> 'app_tenants', '[]'::jsonb))
        )
    );

-- send (presence + client "nudge" hints): may the caller WRITE to this channel?
-- Same tenant gate. Authoritative events are still server-only (service role).
DROP POLICY IF EXISTS hhcp_tenant_realtime_write ON realtime.messages;
CREATE POLICY hhcp_tenant_realtime_write ON realtime.messages
    FOR INSERT TO authenticated
    WITH CHECK (
        coalesce((auth.jwt() -> 'app_fund_admin')::text = 'true', false)
        OR split_part(realtime.topic(), ':', 2) IN (
            SELECT jsonb_array_elements_text(coalesce(auth.jwt() -> 'app_tenants', '[]'::jsonb))
        )
    );
