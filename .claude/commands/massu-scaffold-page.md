---
name: massu-scaffold-page
description: "When user wants to create a new page, route, or section in the app — scaffolds the page component, layout, loading/error states, and tRPC integration"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

# Scaffold New Page

Creates a complete Next.js App Router page following all project patterns.

## What Gets Created

| File | Purpose |
|------|---------|
| `page.tsx` | Main page component with Suspense boundary |
| `loading.tsx` | Skeleton loading state |
| `error.tsx` | Error boundary with retry |

## Template

### page.tsx
```tsx
import { Suspense } from 'react';
import { PageContent } from './page-content';
import Loading from './loading';

export default function Page() {
  return (
    <div className="page-container">
      <Suspense fallback={<Loading />}>
        <PageContent />
      </Suspense>
    </div>
  );
}
```

### page-content.tsx (with params)
```tsx
'use client';

import { use } from 'react';
import { api } from '@/trpc/react';

export function PageContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, isLoading } = api.routerName.getById.useQuery({ id });

  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader title="Page Title" />
      {/* Page content */}
    </>
  );
}
```

### loading.tsx
```tsx
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="page-container">
      <Skeleton className="h-8 w-48 mb-6" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
```

### error.tsx
```tsx
'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="page-container">
      <h2>Something went wrong</h2>
      <p className="text-muted-foreground">{error.message}</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
```

## Gotchas

- **ALWAYS use `page-container`** class on root div — never `container mx-auto`
- **Suspense boundaries** are REQUIRED for pages using `use(params)` or `useSearchParams()`
- **protectedProcedure** for ALL tRPC queries that need auth
- **No `sm:page-container`** — only exception is mobile chat layouts
- **Breadcrumbs**: Add to PageHeader if page is nested (e.g., `/crm/contacts/[id]`)

## Process

1. Ask user: What URL path? What data does it fetch?
2. Determine route segment: `src/app/(app)/[section]/[subsection]/`
3. Create all 3 files (page.tsx, loading.tsx, error.tsx)
4. If data-fetching: verify tRPC router exists, add query
5. Run `npx tsc --noEmit` to verify types

## START NOW

Ask the user what page to create and where it should live in the route hierarchy.
