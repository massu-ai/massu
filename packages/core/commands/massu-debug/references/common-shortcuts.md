# Common Debugging Shortcuts

Quick diagnosis patterns for common error types.

---

## Quick Error Checks

```bash
# All console errors in components
grep -rn "console.error" src/components/

# All try/catch blocks
grep -rn "catch\s*(" src/server/

# All error boundaries
grep -rn "ErrorBoundary\|error.tsx" src/

# Recent server logs (Supabase)
# Use mcp__supabase__[ENV]__get_logs for each environment
```

---

## Quick Pattern Violations

```bash
# Run full pattern check
./scripts/pattern-scanner.sh

# Quick manual checks
grep -rn "ctx.prisma" src/server/ | wc -l      # Should be 0
grep -rn "ctx.db.users" src/ | wc -l           # Should be 0
grep -rn "include:" src/server/ | wc -l        # Should be 0
grep -rn "publicProcedure.mutation" src/ | wc -l  # Should be 0
```

---

## 500 Internal Server Error

1. Check server logs: `mcp__supabase__[ENV]__get_logs`
2. VR-SCHEMA-PRE: Verify table/column existence
3. Check for `ctx.prisma` (should be `ctx.db`)
4. Check for `include:` (should use 3-step queries)
5. Check for `ctx.db.users` (should be `ctx.db.user_profiles`)
6. Check BigInt serialization (use `Number()` on return)
7. Check Decimal serialization (use `serializeUnifiedProduct()`)

---

## 403 Forbidden / 401 Unauthorized

1. Check RLS policies: `scripts/check-rls-policies.sh [table]`
2. Verify service_role grants exist
3. Check `protectedProcedure` vs `publicProcedure`
4. Check middleware routing in `middleware.ts`
5. Check portal_access.portal_type alignment
6. Verify session token validity

---

## React Crash / TypeError

1. Check for `value=""` in any `<Select>` or `<SelectItem>` (use `__none__`)
2. Check null guards on nullable string methods: `(status || "pending").replace()`
3. Check Suspense boundaries for `use(params)` pages
4. Check for `onSuccess` in `useQuery` options (removed in React Query v5)
5. Check useCallback dependency stability (use specific function refs, not parent objects)

---

## Build Failures

1. Check for static jsdom/cheerio imports (must use `await import()`)
2. Check client/server boundary violations (`@/lib/db` in client components)
3. Check `next-intl` setup (plugin + request.ts + Provider)
4. Run `NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit`
5. Check for circular dependencies in import chains

---

## "No Data" / Empty Results

1. VR-DATA: Query actual config values and compare keys to code expectations
2. Check RLS policies allow the operation for the current user role
3. Check grants exist for service_role
4. Verify table exists in the target environment (schema drift)
5. Check if `findManyGeneric` has any hidden default limit

---

## Realtime / Subscription Failures

1. Check query key format: `queryKey: [['router', 'procedure']]` (double brackets)
2. Verify RLS policies exist for the table
3. Check realtime is enabled for the table in Supabase dashboard
4. Verify the subscription channel name matches
