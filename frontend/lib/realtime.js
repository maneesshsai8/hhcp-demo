import { realtime } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";

// Fetch a short-lived Realtime token from the backend (which encodes the
// caller's accessible tenants as claims) and apply it to the Realtime client so
// it may join PRIVATE, tenant-scoped channels. Cached; pass force=true to
// re-mint after a CHANNEL_ERROR / token expiry.
let _authP = null;
export async function authorizeRealtime(force = false) {
  if (!realtime) return false;
  if (force) _authP = null;
  if (!_authP) {
    _authP = apiFetch("/auth/realtime-token")
      .then(async ({ token }) => { await realtime.setAuth(token); return true; })
      .catch(() => { _authP = null; return false; });
  }
  return _authP;
}

// Channel names MUST be tenant-namespaced so the Realtime RLS policy can parse
// the tenant and match it to the token claim (database/realtime_authorization.sql).
export const meetingChannel = (tenantId, meetingId) => `tenant:${tenantId}:meeting:${meetingId}`;
export const tenantAnnouncementsChannel = (tenantId) => `tenant:${tenantId}:announcements`;
export const teamAnnouncementsChannel = (tenantId, teamId) => `tenant:${tenantId}:team:${teamId}:announcements`;
