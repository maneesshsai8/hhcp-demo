"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { completeOAuth } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export default function OAuthCallback() {
  const router = useRouter();
  const { reload } = useAuth();
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        await completeOAuth();   // exchange the code, store the session in an httpOnly cookie
        await reload();          // populate app state from /auth/me
        router.replace("/dashboard/scorecards");
      } catch (e) {
        setError(e.message);
      }
    })();
    // eslint-disable-next-line
  }, []);

  return (
    <div className="login-screen">
      <div className="login-card">
        <p className="login-brand">Hidden Harbor</p>
        {error ? (
          <>
            <div className="error-banner">{error}</div>
            <a className="link-muted" href="/login">← Back to sign in</a>
          </>
        ) : (
          <p className="login-sub">Finishing sign-in…</p>
        )}
      </div>
    </div>
  );
}
