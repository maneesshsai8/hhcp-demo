"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { login, loginWithOAuth, sendSmsOtp, verifySmsOtp } from "@/lib/api";
import { AUTH_PROVIDER } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

const DEMO_ACCOUNTS = [
  { email: "admin@hiddenharbor.com", label: "HH Fund Admin — sees entire portfolio" },
  { email: "priya@hiddenharbor.com", label: "Priya (Ops QB) — Restaurant A + C" },
  { email: "manager.b@restaurantb.com", label: "Restaurant B Manager — B only" },
  { email: "manager.ft@restaurantA.com", label: "Food Truck Manager — Food Truck only" },
];

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("Demo1234!");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [smsMode, setSmsMode] = useState(false);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const router = useRouter();
  const { reload } = useAuth();

  async function doLogin(e) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password);
      await reload();
      router.push("/dashboard/overview");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function doSms(e) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!otpSent) {
        await sendSmsOtp(phone);
        setOtpSent(true);
      } else {
        await verifySmsOtp(phone, otp);
        await reload();
        router.push("/dashboard/overview");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <p className="login-brand">Hidden Harbor</p>
        <p className="login-sub">Business Operating System — demo</p>

        {error && <div className="error-banner">{error}</div>}

        {AUTH_PROVIDER === "supabase" && (
          <>
            <div className="oauth-row">
              <button type="button" className="btn-oauth" onClick={() => loginWithOAuth("google").catch((e) => setError(e.message))}>
                <svg className="oauth-ic" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                Continue with Google
              </button>
              <button type="button" className="btn-oauth" onClick={() => loginWithOAuth("azure").catch((e) => setError(e.message))}>
                <svg className="oauth-ic" viewBox="0 0 23 23" aria-hidden="true">
                  <path fill="#F25022" d="M1 1h10v10H1z"/>
                  <path fill="#7FBA00" d="M12 1h10v10H12z"/>
                  <path fill="#00A4EF" d="M1 12h10v10H1z"/>
                  <path fill="#FFB900" d="M12 12h10v10H12z"/>
                </svg>
                Continue with Microsoft
              </button>
            </div>
            <div className="oauth-divider"><span>or</span></div>
          </>
        )}

        {smsMode ? (
          <form onSubmit={doSms}>
            <div className="field">
              <label>Phone number</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" placeholder="+14155550123" required disabled={otpSent} />
            </div>
            {otpSent && (
              <div className="field">
                <label>SMS code</label>
                <input value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" placeholder="123456" required />
              </div>
            )}
            <button className="btn-primary" disabled={busy} type="submit">
              {busy ? "Please wait…" : otpSent ? "Verify code" : "Send code"}
            </button>
          </form>
        ) : (
          <form onSubmit={doLogin}>
            <div className="field">
              <label>Email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
            </div>
            <div className="field">
              <label>Password</label>
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
            </div>
            <button className="btn-primary" disabled={busy} type="submit">
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}

        {AUTH_PROVIDER === "supabase" && (
          <button type="button" className="link-muted sms-toggle"
            onClick={() => { setSmsMode((s) => !s); setOtpSent(false); setError(""); }}>
            {smsMode ? "← Use email & password" : "Sign in with phone (SMS) instead"}
          </button>
        )}

        <div className="demo-accounts">
          <p style={{ margin: "0 0 6px" }}>Demo accounts (password: Demo1234!)</p>
          {DEMO_ACCOUNTS.map((a) => (
            <button key={a.email} onClick={() => setEmail(a.email)} type="button">
              {a.email} — {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
