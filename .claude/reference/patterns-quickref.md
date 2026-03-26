# Pattern Quick Reference

**Purpose**: Condensed pattern reference. Full patterns with code examples in `patterns/*.md`.

**When to Read**: Quick lookup during implementation. For full details, read the linked pattern file.

---

## Database Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| ctx.db | Use `ctx.db` for ALL ops, NEVER `ctx.prisma` | [database-patterns.md](../patterns/database-patterns.md) |
| user_profiles | Use `ctx.db.user_profiles`, NEVER `ctx.db.users` (auth.users not exposed) | [database-patterns.md](../patterns/database-patterns.md) |
| 3-Step Queries | (1) Base query, (2) Relation query with IN, (3) Map combine | [database-patterns.md](../patterns/database-patterns.md) |
| No include: | Hybrid DB ignores `include:` statements | [database-patterns.md](../patterns/database-patterns.md) |
| emptyToNull | Use for UPDATE forms with clearable fields | [database-patterns.md](../patterns/database-patterns.md) |
| BigInt | NEVER use BigInt() in INSERT; convert to Number() on return | [database-patterns.md](../patterns/database-patterns.md) |
| Decimal | Use serialization helpers for tables with Decimal columns | [database-patterns.md](../patterns/database-patterns.md) |
| RLS + Grants | Tables need BOTH policies AND grants for service_role | [database-patterns.md](../patterns/database-patterns.md) |

---

## Auth Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| getCurrentUser | Use tRPC `api.userProfile.getCurrentUser.useQuery()` | [auth-patterns.md](../patterns/auth-patterns.md) |
| API Route Auth | Use `getUser()` from `@/lib/auth/server` | [auth-patterns.md](../patterns/auth-patterns.md) |
| protectedProcedure | ALL mutations MUST use `protectedProcedure`, never `publicProcedure` | [auth-patterns.md](../patterns/auth-patterns.md) |

---

## Form Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| Phone Input | Use `PhoneInputField` NOT `TextField type="phone"` | [form-patterns.md](../patterns/form-patterns.md) |
| TextField types | Use semantic types: `firstName`, `lastName`, `email`, `company`, `url` | [form-patterns.md](../patterns/form-patterns.md) |
| setValue/watch | ALL TextField/PhoneInputField need `setValue` and `watch` props | [form-patterns.md](../patterns/form-patterns.md) |

---

## UI Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| Logo Usage | `resolvedTheme === 'dark' ? Dark_Mode.png : Light_Mode.png` | [ui-patterns.md](../patterns/ui-patterns.md) |
| Suspense Boundaries | ALL pages with `use(params)` or `useSearchParams()` need Suspense | [ui-patterns.md](../patterns/ui-patterns.md) |
| Null Guards | `(status \|\| "pending").replace()` for nullable string methods | [ui-patterns.md](../patterns/ui-patterns.md) |
| Select.Item | NEVER use `value=""` - causes React crash; use `__none__` placeholder | [ui-patterns.md](../patterns/ui-patterns.md) |
| Mobile Chat | Use `sm:page-container` NOT `page-container` for full-height mobile | [ui-patterns.md](../patterns/ui-patterns.md) |
| NO Modals | ALL overlays use `Sheet` (slide-out panel), NEVER `Dialog`. Only `AlertDialog` for destructive confirms | [CLAUDE.md](../CLAUDE.md) |
| No user-scalable=no | Never disable zoom -- breaks WCAG accessibility | Scanner enforced |
| VR-VISUAL | `bash scripts/ui-review.sh [route]` -- LLM-as-judge visual quality review | [vr-verification-reference.md](vr-verification-reference.md) |

---

## Build Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| JSDOM | NEVER import jsdom statically; use `await import('jsdom')` | [build-patterns.md](../patterns/build-patterns.md) |
| Client/Server Boundary | Client components CANNOT import `@/lib/db` or barrel exports with server code | [build-patterns.md](../patterns/build-patterns.md) |
| next-intl | REQUIRES: (1) plugin in next.config.js, (2) request.ts, (3) NextIntlClientProvider | [build-patterns.md](../patterns/build-patterns.md) |
| React Query v5 | NEVER use `onSuccess` in useQuery options; destructure and use `data` directly | See below |

---

## Security Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| SuperJSON Keys | NEVER use `prototype`, `__proto__`, `constructor` as object KEYS | [CLAUDE.md](../CLAUDE.md) |
| Service Worker | NEVER auto-reload on controllerchange; ALWAYS use `{ once: true }` | [CLAUDE.md](../CLAUDE.md) |
| Credential-first | `getCredentials()` from provider FIRST, `process.env` fallback for dev ONLY | [patterns/security-patterns.md](../patterns/security-patterns.md) |

### Credential Access Pattern (CR-5)

**WRONG (env-first anti-pattern):**
```typescript
const apiKey = process.env.SERVICE_API_KEY;
if (!apiKey) throw new Error('Missing API key');
```

**CORRECT (credential-provider-first):**
```typescript
import { getServiceCredentials } from '@/lib/credentials/provider';

let apiKey: string | undefined;
// CR-5: Credential provider first
try {
  const creds = await getServiceCredentials();
  if (creds.apiKey) apiKey = creds.apiKey;
} catch {
  log.debug('[Service] Credential provider unavailable, falling back to env var');
}
// Dev-only fallback
if (!apiKey) apiKey = process.env.SERVICE_API_KEY;
```

**Typed helpers exist** for services in `src/lib/credentials/provider.ts` -- always prefer the typed helper over raw `getCredentials('service')`.

---

## Realtime Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| Double Bracket QueryKey | `queryKey: [['router', 'procedure']]` NOT single brackets | [realtime-patterns.md](../patterns/realtime-patterns.md) |

---

## Formatting Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| formatFileSize | Use `formatFileSize` from `@/lib/formatting/fields`, NEVER inline definitions | See below |
| formatBytes | DEPRECATED - use `formatFileSize` instead | See below |

### formatFileSize Pattern

**WRONG (inline definition - causes duplication):**
```typescript
// WRONG - creates duplicate implementations
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}
```

**CORRECT (import from canonical location):**
```typescript
// CORRECT - single source of truth
import { formatFileSize } from '@/lib/formatting/fields';

// Use directly
<span>{formatFileSize(file.size)}</span>
```

---

## React Query v5 Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| No onSuccess | NEVER use `onSuccess`/`onError`/`onSettled` in useQuery options | See below |
| Data Access | Destructure `data` from query result and use directly | See below |

### React Query v5 Pattern (tRPC useQuery)

**WRONG (React Query v4 style - causes TypeScript error):**
```typescript
// WRONG - onSuccess removed in React Query v5
const [userId, setUserId] = useState<string | null>(null);

api.userProfile.getCurrentUser.useQuery(undefined, {
  onSuccess: (data) => {
    if (data?.id) {
      setUserId(data.id);
    }
  },
});
```

**CORRECT (React Query v5 style):**
```typescript
// CORRECT - destructure data directly
const { data: currentUser } = api.userProfile.getCurrentUser.useQuery();
const currentUserId = currentUser?.id ?? null;
```

**For side effects on success, use useEffect:**
```typescript
const { data } = api.someRouter.someQuery.useQuery({ ... });

useEffect(() => {
  if (data) {
    // Side effect when data changes
    doSomething(data);
  }
}, [data]);
```

---

## Design System Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| Token Reference | Read `specs/token-reference.md` before CSS work | [specs/token-reference.md](../specs/token-reference.md) |
| Component Specs | Read `specs/components/` before creating/modifying UI | [specs/components/](../specs/components/) |
| Foundation Specs | Read `specs/foundations/` for color/spacing/typography | [specs/foundations/](../specs/foundations/) |
| Token Audit | Run `scripts/audit-design-tokens.sh` after CSS changes | Token audit script |
| No Hardcoded Colors | Use CSS variables from `:root`/`.dark`, never hex in rules | VR-TOKEN |

---

## Simplify & Batch Patterns

| Pattern | Rule | Full Details |
|---------|------|--------------|
| /massu-simplify | Run after changes, before /massu-commit -- parallel efficiency + reuse + pattern review | massu-simplify command |
| /massu-batch | Code-only migrations via parallel worktree agents -- NEVER for database work | massu-batch command |
| Built-in /simplify | Available for quick single-agent simplification (less thorough than /massu-simplify) | Built-in Claude Code skill |
