from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import create_pool, close_pool
from app.routers import auth, organizations, scorecards, rocks, issues, users, teams, meetings, seats, todos, directory, reports
from app.middleware import SecurityHeadersMiddleware, RateLimitMiddleware
from app.realtime import meeting_ws


@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_pool()
    yield
    await close_pool()


app = FastAPI(title="HHCP Business Operating System — Demo", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://localhost:[0-9]+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After", "X-Report-Engine"],
)
# Gateway-concern middleware (see app/middleware.py). Added after CORS so these
# run inside it — CORS/preflight is handled first.
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RateLimitMiddleware, limit=200, window=60)

app.include_router(auth.router)
app.include_router(organizations.router)
app.include_router(users.router)
app.include_router(teams.router)
app.include_router(scorecards.router)
app.include_router(rocks.router)
app.include_router(issues.router)
app.include_router(meetings.router)
app.include_router(seats.router)
app.include_router(todos.router)
app.include_router(directory.router)
app.include_router(reports.router)


app.add_api_websocket_route("/ws/meetings/{meeting_id}", meeting_ws)


@app.get("/health")
async def health():
    return {"status": "ok"}
