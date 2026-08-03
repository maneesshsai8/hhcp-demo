"""
Seeds the demo database with the exact example we've used throughout:

  Hidden Harbor Fund II (fund)
    +-- Restaurant A (portco)
    |     +-- Food Truck (addon)
    +-- Restaurant B (portco)
    +-- Restaurant C (portco)

Users:
  - admin@hiddenharbor.com   -> fund_admin (Tier 1: sees everything, read-only rollup)
  - priya@hiddenharbor.com   -> Ops QB, granted Restaurant A + Restaurant C
                                 (should also see Food Truck via cascade)
  - manager.b@restaurantb.com -> PortCo management, Restaurant B only
  - manager.ft@restaurantA.com -> Add-on management, Food Truck only

All demo passwords: "Demo1234!" (bcrypt-hashed, same as backend will use)

Connects as the 'postgres' superuser so RLS doesn't get in the way of seeding.
"""
import bcrypt
import psycopg2
from datetime import date, datetime, timedelta, timezone

conn = psycopg2.connect(dbname="hhcp_demo")
conn.autocommit = False
cur = conn.cursor()

PASSWORD_HASH = bcrypt.hashpw(b"Demo1234!", bcrypt.gensalt()).decode()


def insert_user(email, name):
    cur.execute(
        "INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) RETURNING id",
        (email, name, PASSWORD_HASH),
    )
    return cur.fetchone()[0]


def insert_org(name, tenant_type, parent_id=None, fund_label=None,
               acquisition_date=None, transaction_type=None):
    cur.execute(
        """INSERT INTO organizations (name, tenant_type, parent_tenant_id, fund_label,
                                       acquisition_date, transaction_type)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
        (name, tenant_type, parent_id, fund_label, acquisition_date, transaction_type),
    )
    return cur.fetchone()[0]


print("Creating organizations (Fund -> PortCo -> Add-on tree)...")
fund_id = insert_org("Hidden Harbor Fund II", "fund")
restaurant_a = insert_org("Restaurant A", "portco", fund_id, "Fund II",
                          date(2024, 3, 1), "buyout")
restaurant_b = insert_org("Restaurant B", "portco", fund_id, "Fund II",
                          date(2023, 11, 15), "buyout")
restaurant_c = insert_org("Restaurant C", "portco", fund_id, "Fund II",
                          date(2026, 7, 1), "buyout")
food_truck = insert_org("Food Truck", "addon", restaurant_a, "Fund II",
                        date(2025, 1, 15), "add-on acquisition")

print("Creating users...")
admin_id = insert_user("admin@hiddenharbor.com", "HH Fund Admin")
priya_id = insert_user("priya@hiddenharbor.com", "Priya (Ops QB)")
mgr_b_id = insert_user("manager.b@restaurantb.com", "Restaurant B Manager")
mgr_ft_id = insert_user("manager.ft@restaurantA.com", "Food Truck Manager")

print("Assigning Tier 1 fund role...")
cur.execute("INSERT INTO fund_roles (user_id, role) VALUES (%s, 'fund_admin')", (admin_id,))

print("Assigning Tier 2 tenant grants...")
cur.execute(
    "INSERT INTO tenant_memberships (user_id, tenant_id, role, granted_by) VALUES (%s, %s, %s, %s)",
    (priya_id, restaurant_a, "ops_qb", admin_id),
)
cur.execute(
    "INSERT INTO tenant_memberships (user_id, tenant_id, role, granted_by) VALUES (%s, %s, %s, %s)",
    (priya_id, restaurant_c, "ops_qb", admin_id),
)
cur.execute(
    "INSERT INTO tenant_memberships (user_id, tenant_id, role, granted_by) VALUES (%s, %s, %s, %s)",
    (mgr_b_id, restaurant_b, "portco_management", admin_id),
)
cur.execute(
    "INSERT INTO tenant_memberships (user_id, tenant_id, role, granted_by) VALUES (%s, %s, %s, %s)",
    (mgr_ft_id, food_truck, "addon_management", admin_id),
)

print("Creating Scorecards (KPIs + 6 weeks of history each)...")


def seed_scorecard(tenant_id, owner_id, title, target, op, unit, weekly_values):
    cur.execute(
        """INSERT INTO kpis (tenant_id, title, owner_id, target_value, comparison_operator, unit)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
        (tenant_id, title, owner_id, target, op, unit),
    )
    kpi_id = cur.fetchone()[0]
    # 6 weeks, most recent = this week ending Sunday
    base = datetime(2026, 7, 26, 23, 59, 59, tzinfo=timezone.utc)
    for i, value in enumerate(weekly_values):
        recorded_at = base - timedelta(weeks=(len(weekly_values) - 1 - i))
        cur.execute(
            "INSERT INTO kpi_scores (tenant_id, kpi_id, recorded_at, actual_value) VALUES (%s, %s, %s, %s)",
            (tenant_id, kpi_id, recorded_at, value),
        )
    return kpi_id


# Restaurant A: sales calls trending off-track the last 3 weeks (to demo the
# "3 consecutive off-track weeks" auto-issue logic from the TimescaleDB doc)
seed_scorecard(restaurant_a, priya_id, "Outbound Sales Calls", 50, ">=", "Calls",
               [48, 52, 55, 42, 40, 38])
seed_scorecard(restaurant_a, priya_id, "Customer Churn Rate", 2.5, "<=", "%",
               [1.8, 2.1, 2.8, 1.9, 2.0, 2.2])

# Restaurant B: healthy, everything on-track
seed_scorecard(restaurant_b, mgr_b_id, "Weekly Revenue", 15000, ">=", "USD",
               [15200, 16100, 15800, 17200, 16900, 18100])

# Restaurant C: brand new PortCo, just 2 weeks of data so far
seed_scorecard(restaurant_c, priya_id, "New Customer Signups", 20, ">=", "Signups",
               [14, 22])

# Food Truck: its own small scorecard
seed_scorecard(food_truck, mgr_ft_id, "Daily Covers Served", 80, ">=", "Covers",
               [72, 85, 90, 88])

print("Creating Rocks (annual priorities)...")
cur.execute(
    "INSERT INTO rocks (tenant_id, title, owner_id, status, due_date) VALUES (%s,%s,%s,%s,%s)",
    (restaurant_a, "Close 12 new commercial contracts", priya_id, "off_track", date(2026, 12, 31)),
)
cur.execute(
    "INSERT INTO rocks (tenant_id, title, owner_id, status, due_date) VALUES (%s,%s,%s,%s,%s)",
    (restaurant_b, "Launch loyalty program", mgr_b_id, "on_track", date(2026, 12, 31)),
)
cur.execute(
    "INSERT INTO rocks (tenant_id, title, owner_id, status, due_date) VALUES (%s,%s,%s,%s,%s)",
    (food_truck, "Add second truck route", mgr_ft_id, "on_track", date(2026, 12, 31)),
)

print("Creating Issues...")
cur.execute(
    "INSERT INTO issues (tenant_id, title, description, status, created_by) VALUES (%s,%s,%s,%s,%s)",
    (restaurant_a, "Sales calls trending down 3 weeks running", "Team may need a refreshed script or more leads.", "open", priya_id),
)
cur.execute(
    "INSERT INTO issues (tenant_id, title, description, status, created_by) VALUES (%s,%s,%s,%s,%s)",
    (restaurant_b, "POS system outage last Tuesday", "Resolved same day, logging for pattern tracking.", "solved", mgr_b_id),
)

conn.commit()
print("\nSeed complete.")
print(f"  Fund:        {fund_id}")
print(f"  Restaurant A: {restaurant_a}")
print(f"  Restaurant B: {restaurant_b}")
print(f"  Restaurant C: {restaurant_c}")
print(f"  Food Truck:   {food_truck}")
print(f"  admin@hiddenharbor.com / priya@hiddenharbor.com / manager.b@restaurantb.com / manager.ft@restaurantA.com")
print(f"  password for all demo users: Demo1234!")

cur.close()
conn.close()
