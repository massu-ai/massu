# Build Patterns

**Purpose**: Patterns for resolving build issues in Next.js applications with Prisma, native modules, and Edge Runtime.

**When to Read**: When encountering build errors, hangs, or warnings. Before adding heavy dependencies.

---

## Client/Server Code Separation

### The Problem

PrismaClient gets bundled into browser JavaScript when imported in client components, causing:
- Build failures
- Massive bundle sizes
- Runtime errors

### The Pattern: Domain Split Files

```
src/lib/services/
├── contacts-types.ts     ← Types only (shared client + server)
├── contacts-service.ts   ← Server logic (PrismaClient, DB queries)
└── contacts-client.ts    ← Client-safe utilities (formatting, validation)
```

**Rule**: Files ending in `-service.ts` contain server code. Client components MUST NOT import them.

```typescript
// contacts-types.ts — SAFE for client import
export interface Contact {
  id: string;
  name: string;
  email: string;
}

export type ContactCreateInput = {
  name: string;
  email: string;
};

// contacts-service.ts — SERVER ONLY
import { db } from '@/lib/db';

export async function getContacts(): Promise<Contact[]> {
  return db.contacts.findMany();
}
```

### Detection

```bash
# Find client components importing server code
grep -rn "from '@/lib/db'" src/components/ --include="*.tsx"
# Expected: 0 matches

# Find barrel exports that leak server code
grep -rn "export \* from.*service" src/lib/
# Check if any client component imports the barrel
```

---

## Native Module Externalization

### The Problem

Modules like `jsdom`, `canvas`, `sharp`, and `puppeteer` contain native binaries that cannot be bundled by webpack/turbopack. They cause build hangs or failures.

### The Pattern

**Step 1: Add to `serverExternalPackages` in `next.config.js`:**
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    'jsdom', 'canvas', 'sharp', 'puppeteer', 'puppeteer-core',
    '@sparticuz/chromium', 'pdfkit', 'pdf-parse'
  ],
};
```

**Step 2: Add webpack externals as fallback:**
```javascript
webpack: (config, { isServer }) => {
  if (isServer) {
    config.externals = config.externals || [];
    config.externals.push({
      jsdom: 'commonjs jsdom',
      canvas: 'commonjs canvas',
      sharp: 'commonjs sharp',
    });
  }
  return config;
},
```

**Step 3: Use dynamic imports:**
```typescript
// WRONG - Static import causes build issues
import { JSDOM } from 'jsdom';

// CORRECT - Dynamic import
const { JSDOM } = await import('jsdom');
```

### Known Problematic Packages

| Package | Issue | Solution |
|---------|-------|---------|
| `jsdom` | ESM + native deps | Dynamic import + externalize |
| `canvas` | Native binary | Externalize |
| `sharp` | Native binary | serverExternalPackages |
| `puppeteer` | Chromium binary | Externalize + dynamic import |
| `cheerio` | Heavy dependency tree | Dynamic import |
| `pdfkit` | Native deps | Externalize |

---

## Edge Runtime Compatibility

### The Rule

Files that run in Edge Runtime (middleware, edge functions) CANNOT use Node.js APIs.

**Banned in Edge Runtime:**
- `fs` / `path` / `crypto` (Node.js builtins)
- `pino` / `winston` (logging libraries with Node.js deps)
- `PrismaClient` (requires Node.js)
- Any package that imports Node.js builtins

### Detection

```bash
# Check middleware for Node.js imports
grep -rn "require('fs')\|require('path')\|require('crypto')" src/middleware.ts
# Expected: 0 matches

# Check for logging library imports in edge files
grep -rn "from 'pino'\|from 'winston'" src/middleware.ts
# Expected: 0 matches
```

### Alternative for Edge Runtime

```typescript
// WRONG - pino in middleware
import pino from 'pino';

// CORRECT - console in middleware (Edge Runtime safe)
console.log('[middleware]', 'Processing request');

// CORRECT - Use Web Crypto API instead of Node crypto
const hash = await crypto.subtle.digest('SHA-256', data);
```

---

## Import Chain Protection

### The Problem

Even `import type` triggers webpack/turbopack analysis of the entire module graph. If a type-only import points to a file that imports heavy dependencies, the bundler will try to resolve them.

### The Pattern

```typescript
// WRONG - Type import still triggers analysis of heavy-deps.ts
import type { HeavyType } from '@/lib/heavy-deps';

// CORRECT - Inline the type definition
interface HeavyType {
  id: string;
  data: Record<string, unknown>;
}
```

### Detection

```bash
# Find imports from known heavy modules in client code
grep -rn "from '@/lib/db'" src/components/ --include="*.tsx"
grep -rn "from '@/lib/services/.*-service'" src/components/ --include="*.tsx"
# Expected: 0 matches for both
```

---

## Build Warnings

### Zero-Warning Builds

All builds MUST produce zero warnings. Common warning sources and fixes:

| Warning | Cause | Fix |
|---------|-------|-----|
| CSS color deprecation | Hardcoded hex/rgb values | Use CSS variables: `var(--color-name)` |
| Unused variable | Dead code | Remove or prefix with `_` |
| Missing key prop | Map without key | Add `key={item.id}` |
| React hook deps | Missing useEffect dependency | Add to dependency array or wrap in useCallback |

### Semantic Color Classes

Use semantic CSS classes instead of hardcoded colors:

```css
/* WRONG */
.badge { color: #22c55e; }

/* CORRECT */
.badge-primary { color: var(--color-primary); }
.badge-success { color: var(--color-success); }
.badge-warning { color: var(--color-warning); }
.badge-error { color: var(--color-error); }
```

---

## next-intl Setup

If using next-intl for internationalization, ALL three pieces are required:

1. **Plugin in `next.config.js`:**
```javascript
const withNextIntl = require('next-intl/plugin')();
module.exports = withNextIntl(nextConfig);
```

2. **`src/i18n/request.ts`:**
```typescript
import { getRequestConfig } from 'next-intl/server';
export default getRequestConfig(async () => ({
  locale: 'en',
  messages: (await import(`../../messages/en.json`)).default
}));
```

3. **Provider in layout:**
```typescript
import { NextIntlClientProvider } from 'next-intl';
<NextIntlClientProvider locale="en" messages={messages}>
  {children}
</NextIntlClientProvider>
```

Missing any one of these causes build failures.

---

## Suspense Boundaries

Pages using `use(params)` or `useSearchParams()` MUST be wrapped in Suspense:

```typescript
// page.tsx
import { Suspense } from 'react';

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <PageContent />
    </Suspense>
  );
}
```

Without Suspense, static generation fails with cryptic errors.

---

## React Query v5 Callbacks

```typescript
// WRONG - onSuccess removed in React Query v5
api.contacts.list.useQuery(undefined, {
  onSuccess: (data) => setContacts(data),  // TypeScript error
});

// CORRECT - Destructure data directly
const { data: contacts } = api.contacts.list.useQuery();
```

See `patterns/component-patterns.md` for the full React Query v5 pattern.

---

## Quick Reference

| Rule | Pattern | Error if Violated |
|------|---------|-------------------|
| JSDOM dynamic import | `await import('jsdom')` | ESM error on Vercel |
| Cheerio dynamic import | `await import('cheerio')` | Build hang on Vercel |
| Import type from heavy deps | Inline types instead | Build hang (47+ min) |
| Client/Server boundary | No `@/lib/db` in client | PrismaClient bundled |
| next-intl setup | Plugin + request.ts + Provider | Build fails |
| Suspense boundaries | Wrap `use(params)` pages | Static generation fails |
| React Query v5 callbacks | Destructure data, no `onSuccess` in useQuery | TypeScript error |

---

**Document Status**: ACTIVE
**Compliance**: Mandatory for all build-related work
