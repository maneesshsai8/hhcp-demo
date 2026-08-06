"""
Background-worker entrypoint. Run as a SEPARATE process from the API:

    cd backend && venv/bin/python -m app.workers.runner

For a one-shot drain (CI / manual):

    venv/bin/python -c "import asyncio; from app.workers.outbox_worker import drain; print(asyncio.run(drain()))"
"""
import asyncio

from app.workers.outbox_worker import run_forever

if __name__ == "__main__":
    try:
        asyncio.run(run_forever())
    except KeyboardInterrupt:
        pass
