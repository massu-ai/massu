---
name: massu-scaffold-page
description: "When user wants to create a new page, screen, or view — asks which framework target (Next.js, SwiftUI, FastAPI templates, Rust web), then scaffolds component / view / handler with project conventions"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

# Scaffold New Page / View

This default template is **framework-agnostic**. It asks the user (or, when invoked by an agent, infers from `massu.config.yaml`) which target to scaffold, then dispatches to one of the embedded patterns below.

> **If your project ships a stack-specific variant** of this template (e.g., `massu-scaffold-page.swift.md`), the variant is preferred and this default is not installed. See `${paths.commands}/README.md` for the variant-resolution rules.

## Step 1 — Pick a target

Ask the user (or read `framework.primary` / `framework.languages` from the consumer's `massu.config.yaml`):

| Stack | Path A: web | Path B: native / mobile | Path C: backend rendered |
|-------|-------------|-------------------------|--------------------------|
| TypeScript / Next.js | `app/<route>/page.tsx` + loading + error | — | — |
| Swift / SwiftUI | — | `Features/<feature>/Views/<Name>View.swift` (+ ViewModel + Response) | — |
| Python / FastAPI | — | — | Jinja template + handler in `routers/<name>.py` |
| Rust / Axum | — | — | `src/handlers/<name>.rs` returning `Html` or JSON |

If the user is unsure, default to whatever `framework.primary` points at.

---

## Pattern 1 — Next.js App Router page

### What gets created

- `${paths.web_source}/app/<route>/page.tsx`
- `${paths.web_source}/app/<route>/loading.tsx`
- `${paths.web_source}/app/<route>/error.tsx`

### `page.tsx`

```tsx
import { Suspense } from 'react';
import { PageContent } from './page-content';
import Loading from './loading';

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <PageContent />
    </Suspense>
  );
}
```

### `page-content.tsx`

```tsx
'use client';

import { useEffect, useState } from 'react';

export function PageContent() {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Substitute the URL with your project's API base — tRPC client, REST URL, etc.
    fetch(`${process.env.NEXT_PUBLIC_API_BASE ?? '/api'}/<endpoint>`, {
      credentials: 'include',
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData(await r.json());
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) throw new Error(error);
  if (!data) return null;
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
```

### `loading.tsx` / `error.tsx`

```tsx
// loading.tsx — show a skeleton, NOT a flash of empty state.
export default function Loading() {
  return <div className="page-skeleton" />;
}
```

```tsx
// error.tsx — must be a client component. Provides a retry handle to the user.
'use client';
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert">
      <p>Something went wrong: {error.message}</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
```

### Verification

```bash
npm run build 2>&1 | tail -20   # or pnpm/yarn equivalent
```

---

## Pattern 2 — SwiftUI iOS / visionOS view

(Full version available as the `.swift.md` variant of this template.)

### What gets created

- `${paths.swift_source}/Features/<feature>/Views/<Name>View.swift`
- `${paths.swift_source}/Features/<feature>/ViewModels/<Name>ViewModel.swift`
- `${paths.swift_source}/Features/<feature>/Models/<Name>Response.swift`

### Sketch

```swift
struct <Name>View: View {
    @StateObject private var viewModel = <Name>ViewModel()
    var body: some View {
        Group {
            if viewModel.isLoading { ProgressView() }
            else if let err = viewModel.error { ErrorState(message: err) { Task { await viewModel.load() } } }
            else { content }
        }
        .task { await viewModel.load() }
    }
    private var content: some View { /* real content */ EmptyView() }
}

@MainActor
final class <Name>ViewModel: ObservableObject {
    @Published var data: <Name>Response?
    @Published var isLoading = false
    @Published var error: String?
    func load() async { /* fetch and decode */ }
}
```

**Critical**: With `JSONDecoder.keyDecodingStrategy = .convertFromSnakeCase`, mismatched property names decode to nil silently. Hand-verify every Decodable property against a real API response.

### Verification

```bash
xcodebuild -scheme <Target>_iOS -destination 'generic/platform=iOS Simulator' build | tail -20
```

---

## Pattern 3 — FastAPI Jinja-rendered page

### What gets created

- `${paths.python_source}/routers/<name>.py` (Jinja-rendering handler)
- `${paths.python_templates}/<name>.html`

### Sketch

```python
from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from ._shared import get_current_user

router = APIRouter()
templates = Jinja2Templates(directory="${paths.python_templates}")

@router.get("/<route>", response_class=HTMLResponse)
async def render(request: Request, user: dict = Depends(get_current_user)):
    return templates.TemplateResponse("<name>.html", {"request": request, "user": user})
```

**Critical**: this pattern serves HTML from FastAPI directly; for pure-API endpoints, use `/massu-scaffold-router` instead.

---

## Pattern 4 — Axum (Rust) HTML handler

### What gets created

- `${paths.rust_source}/handlers/<name>.rs`
- Wire-up in `src/main.rs` or `src/router.rs` via `.route("/<path>", get(<name>::handler))`.

### Sketch

```rust
use axum::{response::Html, routing::get, Router};

pub fn router() -> Router {
    Router::new().route("/<path>", get(handler))
}

async fn handler() -> Html<&'static str> {
    Html("<!doctype html><meta charset='utf-8'><title>Page</title><h1>Hello</h1>")
}
```

### Verification

```bash
cargo build 2>&1 | tail -10 && cargo test --quiet
```

---

## START NOW

Ask the user (in this order):

1. **Which target?** TS / Next.js · Swift / SwiftUI · Python / FastAPI · Rust / Axum. Default to `framework.primary` from `massu.config.yaml` if the user is unsure.
2. What's the URL path / feature name?
3. What does the page render, and which API endpoint feeds it?
4. Any auth requirements? (logged-in only · role-gated · biometric-gated for sensitive actions)
