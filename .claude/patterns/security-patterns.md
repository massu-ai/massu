# Security Patterns

**Purpose**: Security patterns for credential management, authentication, and code safety.

**When to Read**: Before handling secrets, authentication, or security-sensitive code.

---

## Credential Management (CR-5)

### The Rule

ALL secrets MUST use a credential provider (e.g., AWS Secrets Manager). Environment variables are acceptable ONLY as a development fallback.

### Credential Access Pattern

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

### Path Convention

Store secrets with a structured path convention:

```
{project}/api-credentials/{environment}/{service-name}
```

Example paths:
- `my-app/api-credentials/production/stripe`
- `my-app/api-credentials/development/anthropic`
- `my-app/api-credentials/production/sendgrid`

### Credential Loader Template

```typescript
// src/lib/credentials/{service}-credentials.ts
import { getCredentials } from '@/lib/credentials/provider';

interface ServiceCredentials {
  apiKey: string;
  apiSecret?: string;
}

let cachedCredentials: ServiceCredentials | null = null;
let loadPromise: Promise<ServiceCredentials> | null = null;

export async function getServiceCredentials(): Promise<ServiceCredentials> {
  if (cachedCredentials) return cachedCredentials;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const raw = await getCredentials('my-app/api-credentials/production/service-name');
    cachedCredentials = {
      apiKey: raw.api_key,
      apiSecret: raw.api_secret,
    };
    return cachedCredentials;
  })();

  return loadPromise;
}
```

**Key patterns:**
- Lazy initialization (load on first use)
- Promise deduplication (prevent parallel loads)
- Typed return values (no raw strings)

### Service Templates

| Service | Credential Fields | Environment Variable Fallback |
|---------|------------------|------------------------------|
| Stripe | `secret_key`, `publishable_key`, `webhook_secret` | `STRIPE_SECRET_KEY` |
| Twilio | `account_sid`, `auth_token` | `TWILIO_AUTH_TOKEN` |
| SendGrid | `api_key` | `SENDGRID_API_KEY` |
| Anthropic | `api_key` | `ANTHROPIC_API_KEY` |
| OpenAI | `api_key` | `OPENAI_API_KEY` |

---

## Authentication Patterns

### Protected Procedures

ALL mutations MUST use `protectedProcedure`:

```typescript
// CORRECT
export const myRouter = createTRPCRouter({
  create: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // ctx.user is guaranteed to exist
      return ctx.db.items.create({ data: input });
    }),
});

// WRONG - Security vulnerability
export const myRouter = createTRPCRouter({
  create: publicProcedure  // NEVER use publicProcedure for mutations
    .mutation(async ({ input }) => { ... }),
});
```

### Input Validation

ALL inputs MUST be validated with Zod:

```typescript
import { z } from 'zod';

// Define strict schemas
const createItemSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  amount: z.number().positive().max(1000000),
  status: z.enum(['draft', 'active', 'archived']),
});
```

---

## Code Safety Patterns

### SuperJSON Key Safety

NEVER use these as object keys — causes prototype pollution:

```typescript
// WRONG - Prototype pollution vulnerability
const data = {
  prototype: { ... },    // DANGEROUS
  __proto__: { ... },    // DANGEROUS
  constructor: { ... },  // DANGEROUS
};

// CORRECT - Use safe key names
const data = {
  prototypeData: { ... },
  config: { ... },
};
```

### Service Worker Safety

```typescript
// WRONG - Causes infinite refresh loop
navigator.serviceWorker.addEventListener('controllerchange', () => {
  window.location.reload();
});

// CORRECT - Only reload once
navigator.serviceWorker.addEventListener('controllerchange', () => {
  window.location.reload();
}, { once: true });
```

---

## Pre-Commit Security Checks

Before committing, verify no secrets are staged:

```bash
# Check for env files
git diff --cached --name-only | grep -E '\.(env|pem|key|secret)'
# Expected: 0 matches

# Check for API key patterns
git diff --cached | grep -E 'sk-[a-zA-Z0-9]{20,}|api_key.*=.*[a-zA-Z0-9]{20,}'
# Expected: 0 matches

# Check for common secret patterns
git diff --cached | grep -iE 'password\s*=\s*["\x27][^"\x27]+["\x27]|secret\s*=\s*["\x27][^"\x27]+["\x27]'
# Expected: 0 matches
```

---

## Security Verification Commands

| Check | Command | Expected |
|-------|---------|----------|
| No secrets staged | `git diff --cached \| grep -E 'sk-\|api_key'` | 0 matches |
| Protected procedures | `grep -rn "publicProcedure.mutation" src/` | 0 matches |
| Zod validation | `grep -rn "\.input(z\." src/server/api/routers/` | Match on all mutations |
| No prototype keys | `grep -rn "prototype:" src/ \| grep -v test` | 0 matches |

---

## Related Documentation

- **Build Patterns**: `patterns/build-patterns.md` (Edge Runtime restrictions)
- **Testing Patterns**: `patterns/testing-patterns.md` (security testing)
- **Standards**: `reference/standards.md` (security standards)

---

**Document Status**: ACTIVE
**Compliance**: Mandatory — all credential access must follow provider-first pattern
