---
name: massu-scaffold-router
description: "FastAPI-specific scaffold for {{paths.python_source | default("app")}}/routers/ — creates the router file, registers it in main.py, adds Pydantic schemas, and applies the project's detected auth dependency"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

# Scaffold New FastAPI Router

Creates a complete FastAPI router following the project's existing conventions in `{{paths.python_source | default("app")}}/routers/`. Auth dependency sourced from the massu introspector's `detected.python.auth_dep` (falls back to `get_current_user` if not detected).

## What Gets Created

| File | Purpose |
|------|---------|
| `{{paths.python_source | default("app")}}/routers/<name>.py` | Router with endpoints |
| Registration in `{{paths.python_source | default("app")}}/main.py` | `app.include_router(...)` |
| `{{paths.python_test | default("tests")}}/test_<name>_router.py` | Router test (auth + happy path + error path) |

> **Auth dependency**: this template uses `{{detected.python.auth_dep | default("get_current_user")}}` — the value introspected from your codebase by massu. If your project uses a different dependency, adjust the import and `Depends(...)` call.

> **Path resolution**: `paths.python_source` and `paths.python_test` come from `massu.config.yaml`. If those keys are not declared, the fallbacks `app/` and `tests/` are used.

## Template

```python
"""<Name> API — describe purpose in one line.

Plan: <plan-id> if applicable. Owner: <subsystem>.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

# Auth dependency detected from your codebase.
from ._shared import {{detected.python.auth_dep | default("get_current_user")}}
# from ..auth import require_role  # for endpoints that mutate sensitive state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="{{detected.python.api_prefix_base | default("/api")}}/<name>", tags=["<name>"])


class FooRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=16)
    # ALWAYS bound numeric inputs — open-ended floats are how unit-mismatch and
    # APY-style overflow bugs sneak through.
    quantity: float = Field(gt=0, le=1_000_000)


class FooResponse(BaseModel):
    ok: bool
    payload: dict


@router.get("/items")
async def list_items(
    request: Request,
    user: dict = Depends({{detected.python.auth_dep | default("get_current_user")}}),
) -> FooResponse:
    """List items. Read-only — base auth dependency is sufficient."""
    # Async-only I/O. Wrap external calls with `async with asyncio.timeout(N)`;
    # client-library timeouts (httpx, aiohttp) alone do not cover DNS/TLS hangs.
    return FooResponse(ok=True, payload={"items": []})


@router.post("/orders")
async def create_order(
    body: FooRequest,
    request: Request,
    user: dict = Depends({{detected.python.auth_dep | default("get_current_user")}}),  # SWAP for require_role(...) for any state-mutating action
) -> FooResponse:
    """Mutating endpoint — enforce role-based auth (or service-token) here."""
    logger.info("order created symbol=%s qty=%s user=%s", body.symbol, body.quantity, user.get("user_id"))
    return FooResponse(ok=True, payload={"symbol": body.symbol, "qty": body.quantity})
```

## Registration in `main.py`

```python
# at top of file with other router imports
from .routers.<name> import router as <name>_router

# in the section where other routers are included
app.include_router(<name>_router)
```

## Test scaffold (`{{paths.python_test | default("tests")}}/test_<name>_router.py`)

```python
import pytest
from httpx import AsyncClient, ASGITransport

from <project_package>.main import app  # substitute your top-level package


@pytest.mark.asyncio
async def test_list_items_requires_auth():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.get("{{detected.python.api_prefix_base | default("/api")}}/<name>/items")
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_create_order_input_validation(auth_headers):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.post("{{detected.python.api_prefix_base | default("/api")}}/<name>/orders", json={"symbol": "", "quantity": 0}, headers=auth_headers)
    assert r.status_code == 422
```

## FastAPI Conventions (apply in any project)

- **Auth choice**:
  - `Depends({{detected.python.auth_dep | default("get_current_user")}})` for read-only endpoints
  - A role-gated dependency (e.g. `require_role("admin")`) for ANY state-mutating endpoint — non-negotiable for safety-critical surfaces
  - Service-token / machine-auth checks happen BEFORE any "auth disabled" dev bypass
- **Async only**: every I/O call uses `async def` + `await`. Wrap external calls in `async with asyncio.timeout(N)` — internal client-library timeouts are not enough for DNS/TLS hangs.
- **Bound numeric inputs**: `Field(gt=..., le=...)` on every numeric. Open-ended ranges produce overflow bugs in financial / metric / quantity contexts.
- **Validate input strings**: symbols, IDs, slugs — use a project-local validator, never trust raw `str` for downstream lookups.
- **No hardcoded sentinel values**: `0`, `0.00`, `""`, `None` are usually indistinguishable from real values. Be deliberate.
- **Module-level state**: locks must be lazy (`asyncio.Lock()` at module top binds to the wrong loop). Background `create_task()` returns must be stored in a module-level set with `add_done_callback` to prevent GC.
- **Silent drops log WARNING** — never DEBUG. Anything dropped at scale must be visible in production logs.
- **Dependency injection**: any class that touches sensitive state (trades, memory, billing) should accept its dependencies via constructor or `set_*` — never assume singleton is pre-wired.

## Process

1. Ask user: what subsystem owns this router? What endpoints does it need? Which are read-only vs mutating?
2. Confirm path: `{{paths.python_source | default("app")}}/routers/<name>.py`. If the name collides with an existing router, stop and ask.
3. Write the router file using the template above; pick the right auth dependency per endpoint.
4. Write the test scaffold and confirm it imports cleanly: `pytest {{paths.python_test | default("tests")}}/test_<name>_router.py -x --collect-only`.
5. Add the `app.include_router(<name>_router)` line to `main.py` AFTER the file exists (split-commit safety).
6. Verify route registration:
   ```bash
   python -c "from <project_package>.main import app; print([r.path for r in app.routes if '/api/<name>' in str(r.path)])"
   ```
7. Restart the service and curl-smoke the new endpoint (tests passing ≠ running process has the change).

## START NOW

Ask the user:
1. What subsystem/feature owns this router?
2. What's the URL prefix? (default: `{{detected.python.api_prefix_base | default("/api")}}/<name>`)
3. What endpoints, and which are mutating vs read-only?
4. Does any endpoint touch sensitive state (trades, billing, user permissions)? That decides whether to use a role-gated dependency vs the base auth dependency.
