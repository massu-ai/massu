---
name: massu-scaffold-router
description: "When user wants to create a new tRPC router, API endpoint, or backend procedure — scaffolds router file, registers in root.ts, adds Zod schemas"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

# Scaffold New tRPC Router

Creates a complete tRPC router following all project database and auth patterns.

## What Gets Created

| File | Purpose |
|------|---------|
| `src/server/api/routers/[name].ts` | Router with procedures |
| Registration in `src/server/api/root.ts` | Import + add to appRouter |

## Template

```typescript
import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '@/server/api/trpc';

export const myEntityRouter = createTRPCRouter({
  getAll: protectedProcedure
    .query(async ({ ctx }) => {
      const items = await ctx.db.my_table.findMany({
        orderBy: { created_at: 'desc' },
      });
      return items;
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const item = await ctx.db.my_table.findUnique({
        where: { id: input.id },
      });
      if (!item) throw new Error('Not found');
      return item;
    }),

  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      // Add fields here
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.my_table.create({
        data: {
          ...input,
          created_by: ctx.session.user.id,
        },
      });
    }),

  update: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.db.my_table.update({
        where: { id },
        data,
      });
    }),
});
```

## 3-Step Query Pattern (for relations)

```typescript
// Step 1: Base query
const items = await ctx.db.my_table.findMany({ where: { status: 'active' } });

// Step 2: Relation query with IN
const relatedIds = items.map(i => i.related_id).filter(Boolean);
const related = relatedIds.length > 0
  ? await ctx.db.related_table.findMany({ where: { id: { in: relatedIds } } })
  : [];

// Step 3: Map combine
const relatedMap = new Map(related.map(r => [r.id, r]));
return items.map(item => ({
  ...item,
  related: item.related_id ? relatedMap.get(item.related_id) : null,
}));
```

## Registration in root.ts

```typescript
import { myEntityRouter } from './routers/my-entity';

export const appRouter = createTRPCRouter({
  // ... existing routers
  myEntity: myEntityRouter,
});
```

## Gotchas

- **ctx.db NOT ctx.prisma** — hybrid client requires ctx.db
- **protectedProcedure for ALL mutations** — never publicProcedure
- **No `include:`** — hybrid DB ignores include statements; use 3-step query
- **user_profiles NOT users** — `ctx.db.user_profiles` (auth.users not exposed)
- **BigInt**: convert to `Number()` on return, NEVER use `BigInt()` in INSERT
- **Decimal**: use `serializeUnifiedProduct()` for unified_products (8 Decimal cols)
- **New tables**: add to `src/lib/db.ts` DatabaseClient BEFORE using in routers
- **Split-commit**: NEVER add import to root.ts before router file exists

## Process

1. Ask user: What entity? What operations (CRUD, custom)?
2. Run VR-SCHEMA-PRE to verify table columns exist
3. Create router file with proper patterns
4. Register in root.ts
5. Run `npx tsc --noEmit` to verify types

## START NOW

Ask the user what entity/table the router is for and what procedures it needs.
