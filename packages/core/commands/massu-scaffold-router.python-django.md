---
name: massu-scaffold-router
description: "Django-specific scaffold for {{paths.python_source | default("django_app")}}/views.py — creates function-based and class-based views with login_required, plus urls.py registration"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

# Scaffold New Django View

Creates Django views in `{{paths.python_source | default("django_app")}}` following the project's conventions. Covers function-based views (FBV), class-based views (CBV), and the corresponding `urls.py` registration. Auth guard uses `{{detected.python.auth_dep | default("login_required")}}`.

## What Gets Created

| File | Purpose |
|------|---------|
| `{{paths.python_source | default("django_app")}}/views.py` | FBV + CBV examples |
| `{{paths.python_source | default("django_app")}}/urls.py` | URL routing registration |
| `{{paths.python_test | default("tests")}}/test_<name>_views.py` | View tests (auth + happy path) |

> **Auth decorator**: this template uses `{{detected.python.auth_dep | default("login_required")}}` — sourced from the massu introspector. If your project uses a custom decorator or `@permission_required`, swap it in.

## Template — Function-Based View

```python
"""<Name> views — describe purpose in one line."""

import logging

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_http_methods

# Use the detected auth decorator if your project wraps the Django built-in.
# from .auth import {{detected.python.auth_dep | default("login_required")}}

logger = logging.getLogger(__name__)


@{{detected.python.auth_dep | default("login_required")}}
@require_http_methods(["GET"])
def list_items(request: HttpRequest) -> JsonResponse:
    """List items. Read-only — login guard is sufficient."""
    return JsonResponse({"ok": True, "items": []})


@{{detected.python.auth_dep | default("login_required")}}
@require_http_methods(["POST"])
def create_item(request: HttpRequest) -> JsonResponse:
    """Create an item. Mutating — ensure the auth decorator enforces the right role."""
    # Validate POST body here — never trust raw request.POST for numeric / typed fields.
    logger.info("item created by user=%s", request.user.pk)
    return JsonResponse({"ok": True})
```

## Template — Class-Based View

```python
from django.contrib.auth.mixins import LoginRequiredMixin
from django.views import View
from django.http import HttpRequest, JsonResponse


class ItemListView(LoginRequiredMixin, View):
    """Class-based list view. LoginRequiredMixin redirects unauthenticated users."""

    def get(self, request: HttpRequest) -> JsonResponse:
        return JsonResponse({"ok": True, "items": []})


class ItemDetailView(LoginRequiredMixin, View):
    def get(self, request: HttpRequest, pk: int) -> JsonResponse:
        # Fetch from DB; raise Http404 if not found.
        return JsonResponse({"ok": True, "id": pk})
```

## Template — `urls.py` Registration

```python
from django.urls import path
from . import views

app_name = "<name>"

urlpatterns = [
    path("items/", views.list_items, name="list"),
    path("items/create/", views.create_item, name="create"),
    # CBV registration:
    path("items/<int:pk>/", views.ItemDetailView.as_view(), name="detail"),
]
```

Then include in the project's root `urls.py`:

```python
from django.urls import path, include

urlpatterns = [
    # ...
    path("api/<name>/", include("<app_label>.urls")),
]
```

## Test scaffold (`{{paths.python_test | default("tests")}}/test_<name>_views.py`)

```python
import pytest
from django.test import Client
from django.contrib.auth import get_user_model

User = get_user_model()


@pytest.mark.django_db
def test_list_items_requires_auth(client: Client):
    response = client.get("/api/<name>/items/")
    # login_required redirects; DRF returns 403 — accept either.
    assert response.status_code in (302, 401, 403)


@pytest.mark.django_db
def test_list_items_authenticated(client: Client, django_user_model):
    user = django_user_model.objects.create_user(username="tester", password="pass")
    client.force_login(user)
    response = client.get("/api/<name>/items/")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
```

## Django Conventions

- **Always guard mutating views** with `{{detected.python.auth_dep | default("login_required")}}` (or a role/permission mixin for sensitive operations).
- **Use `LoginRequiredMixin` for CBVs** — decorator-only auth on CBVs can be bypassed via HTTP method routing.
- **Never trust `request.POST` for typed fields** — validate with a Django Form or DRF serializer.
- **Atomic DB writes** — wrap multi-step mutations in `django.db.transaction.atomic`.
- **CSRF** — `@require_http_methods` does NOT exempt CSRF. For JSON APIs, either use DRF's `CSRFExemptSessionAuthentication` or enforce the CSRF token client-side.
- **Avoid N+1** — use `select_related` / `prefetch_related` in list views.

## Process

1. Ask user: which Django app (`app_label`)? What URL prefix? What views are needed?
2. Confirm path: `{{paths.python_source | default("django_app")}}/views.py`.
3. Write or append to `views.py`; write the `urls.py` snippet.
4. Include the URL conf in the project root `urls.py`.
5. Run migrations if the new views touch new models: `python manage.py makemigrations && python manage.py migrate`.
6. Smoke: `python manage.py runserver` and curl or use the test client.

## START NOW

Ask the user:
1. Which Django app (label) owns these views?
2. What URL prefix? (e.g. `api/<name>/`)
3. Function-based or class-based views (or both)?
4. Does any view touch sensitive state? — that decides the auth decorator vs mixin.
