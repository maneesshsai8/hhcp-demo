"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/api";
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
  const router = useRouter();
  const { reload } = useAuth();

  async function doLogin(e) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password);
      await reload();
      router.push("/dashboard/scorecards");
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
