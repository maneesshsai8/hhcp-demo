"""
Seeds the exact structure from the Portfolio Role-Based Access diagram, via
the real API (so every create goes through the RLS-enforced path):

  Hidden Harbor Fund II (existing Fund)
   ├── Dayco (PortCo)
   │    ├── Add-on 1
   │    └── Add-on 2
   ├── Rapid Group (PortCo)
   └── Noble Fueling (PortCo)

  Users (Tier 2), each a cross-tenant user covering all three PortCos:
   - Larry Chen   (Lead Partner) -> lead_partner on Dayco, Rapid Group, Noble Fueling
   - Deepa Rao    (Deal QB)      -> deal_qb      on Dayco, Rapid Group, Noble Fueling
   - Omar Silva   (Ops QB)       -> ops_qb       on Dayco, Rapid Group, Noble Fueling

  Team: "Dayco Leadership Team" (in Dayco) with Deepa + Omar, plus one Rock
  assigned to it. Add-ons need no grant — access to Dayco cascades down.

Idempotent-ish: skips creating an org/user that already exists by name/email.
Re-runnable. Existing Restaurant demo data is left untouched.
"""
import json
import urllib.request

API = "http://localhost:8000"
ADMIN = {"email": "admin@hiddenharbor.com", "password": "Demo1234!"}
PW = "Demo1234!"


def call(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code}: {e.read().decode()}")


def main():
    token = call("POST", "/auth/login", body=ADMIN)["access_token"]

    orgs = {o["name"]: o for o in call("GET", "/organizations", token)}
    fund_id = next(o["id"] for o in orgs.values() if o["tenant_type"] == "fund")

    def ensure_org(name, tenant_type, parent_id=None, **meta):
        if name in orgs:
            print(f"  = {name} (exists)")
            return orgs[name]["id"]
        body = {"name": name, "tenant_type": tenant_type, "parent_tenant_id": parent_id, **meta}
        res = call("POST", "/organizations", token, body)
        orgs[name] = res
        print(f"  + {name} ({tenant_type})")
        return res["id"]

    print("PortCos + Add-ons:")
    dayco = ensure_org("Dayco", "portco", fund_id, fund_label="Fund II", transaction_type="buyout")
    ensure_org("Add-on 1", "addon", dayco)
    ensure_org("Add-on 2", "addon", dayco)
    rapid = ensure_org("Rapid Group", "portco", fund_id, fund_label="Fund II", transaction_type="buyout")
    noble = ensure_org("Noble Fueling", "portco", fund_id, fund_label="Fund II", transaction_type="carveout")

    print("Users:")
    users = {u["email"]: u for u in call("GET", "/users", token)}

    def ensure_user(name, email):
        if email in users:
            print(f"  = {email} (exists)")
            return users[email]["id"]
        res = call("POST", "/users", token, {"name": name, "email": email, "password": PW})
        users[email] = res
        print(f"  + {name} <{email}>")
        return res["id"]

    larry = ensure_user("Larry Chen (Lead Partner)", "larry.partner@hiddenharbor.com")
    deepa = ensure_user("Deepa Rao (Deal QB)", "deepa.dealqb@hiddenharbor.com")
    omar = ensure_user("Omar Silva (Ops QB)", "omar.opsqb@hiddenharbor.com")

    print("Grants (each role covers all three PortCos):")
    plan = [
        (larry, "lead_partner"),
        (deepa, "deal_qb"),
        (omar, "ops_qb"),
    ]
    for user_id, role in plan:
        for tid in (dayco, rapid, noble):
            call("POST", "/organizations/grants", token, {"user_id": user_id, "tenant_id": tid, "role": role})
        print(f"  + {role} -> Dayco, Rapid Group, Noble Fueling")

    print("Team + a Rock assigned to it:")
    teams = {t["name"]: t for t in call("GET", "/teams", token)}
    if "Dayco Leadership Team" in teams:
        team_id = teams["Dayco Leadership Team"]["id"]
        print("  = Dayco Leadership Team (exists)")
    else:
        team_id = call("POST", "/teams", token, {"tenant_id": dayco, "name": "Dayco Leadership Team"})["id"]
        print("  + Dayco Leadership Team")
    for uid in (deepa, omar):
        call("POST", f"/teams/{team_id}/members", token, {"user_id": uid})
    call("POST", "/rocks", token, {"tenant_id": dayco, "title": "Integrate Add-on 1 & 2 operations", "team_id": team_id})
    print("  + Rock 'Integrate Add-on 1 & 2 operations' -> Dayco Leadership Team")

    print("\nDone. Login for any new user: password", PW)


if __name__ == "__main__":
    main()
