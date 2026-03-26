# Testing Patterns

**Purpose**: Testing pyramid, patterns, and best practices for unit, integration, and E2E tests.

**When to Read**: Before writing tests, setting up test infrastructure, or debugging test failures.

---

## Testing Pyramid

| Level | Coverage | Tools | Speed |
|-------|----------|-------|-------|
| Unit | 80% | Vitest + Testing Library | Fast (seconds) |
| Integration | 15% | Vitest + tRPC test utils | Medium (seconds) |
| E2E | 5% | Playwright | Slow (minutes) |

---

## 1. Unit Testing (80% of Tests)

### Location Convention

```
src/
├── __tests__/                    # Unit tests
│   ├── lib/                      # Utility tests
│   │   └── calculateTotal.test.ts
│   ├── components/               # Component tests
│   │   └── StatusBadge.test.tsx
│   └── hooks/                    # Hook tests
│       └── useDebounce.test.ts
```

### Example 1: Business Logic

```typescript
// src/__tests__/lib/calculateTotal.test.ts
import { describe, it, expect } from 'vitest';
import { calculateOrderTotal } from '@/lib/calculations/order';

describe('calculateOrderTotal', () => {
  it('should calculate total with tax', () => {
    const items = [
      { price: 100, quantity: 2 },
      { price: 50, quantity: 1 },
    ];

    const result = calculateOrderTotal(items, { taxRate: 0.08 });

    expect(result.subtotal).toBe(250);
    expect(result.tax).toBe(20);
    expect(result.total).toBe(270);
  });

  it('should handle empty items', () => {
    const result = calculateOrderTotal([], { taxRate: 0.08 });

    expect(result.subtotal).toBe(0);
    expect(result.tax).toBe(0);
    expect(result.total).toBe(0);
  });

  it('should apply discount', () => {
    const items = [{ price: 100, quantity: 1 }];

    const result = calculateOrderTotal(items, {
      taxRate: 0.08,
      discountPercent: 10,
    });

    expect(result.subtotal).toBe(100);
    expect(result.discount).toBe(10);
    expect(result.tax).toBe(7.2); // Tax on discounted amount
    expect(result.total).toBe(97.2);
  });
});
```

### Example 2: React Component

```typescript
// src/__tests__/components/StatusBadge.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '@/components/common/StatusBadge';

describe('StatusBadge', () => {
  it('should render active status with green badge', () => {
    render(<StatusBadge status="active" />);

    const badge = screen.getByText('Active');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('badge-success');
  });

  it('should handle null status gracefully', () => {
    render(<StatusBadge status={null} />);

    const badge = screen.getByText('Pending');
    expect(badge).toBeInTheDocument();
  });

  it('should capitalize status text', () => {
    render(<StatusBadge status="in_progress" />);

    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });
});
```

### Example 3: Custom Hook

```typescript
// src/__tests__/hooks/useDebounce.test.ts
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebounce } from '@/hooks/useDebounce';

describe('useDebounce', () => {
  it('should debounce value changes', async () => {
    vi.useFakeTimers();

    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 300),
      { initialProps: { value: 'initial' } }
    );

    expect(result.current).toBe('initial');

    rerender({ value: 'updated' });
    expect(result.current).toBe('initial'); // Not yet updated

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toBe('updated'); // Now updated

    vi.useRealTimers();
  });
});
```

---

## 2. Integration Testing (15% of Tests)

### Location Convention

```
tests/
├── integration/
│   ├── routers/           # tRPC router tests
│   │   └── orders.test.ts
│   ├── database/          # Database transaction tests
│   │   └── transactions.test.ts
│   └── helpers/
│       └── trpc.ts        # Test caller setup
```

### tRPC Router Testing

```typescript
// tests/integration/routers/orders.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createCaller } from '../helpers/trpc';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Integration: Orders Router', () => {
  let caller: ReturnType<typeof createCaller>;
  const testCustomerId = 'test-customer-123';

  beforeAll(async () => {
    caller = createCaller({ userId: 'test-user-id' });

    // Setup test data
    await prisma.customer.create({
      data: { id: testCustomerId, name: 'Test Customer', email: 'test@example.com' }
    });

    await prisma.product.create({
      data: { id: 'test-product-789', name: 'Test Product', price: 100, inventory_quantity: 100 }
    });
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { order: { customerId: testCustomerId } } });
    await prisma.order.deleteMany({ where: { customerId: testCustomerId } });
    await prisma.product.deleteMany({ where: { id: 'test-product-789' } });
    await prisma.customer.deleteMany({ where: { id: testCustomerId } });
    await prisma.$disconnect();
  });

  it('should create order and update inventory', async () => {
    const result = await caller.orders.create({
      customerId: testCustomerId,
      items: [
        { productId: 'test-product-789', quantity: 5, price: 100 }
      ]
    });

    expect(result.total).toBe(500);
    expect(result.status).toBe('pending');

    // Verify inventory updated
    const product = await prisma.product.findUnique({
      where: { id: 'test-product-789' }
    });
    expect(product?.inventory_quantity).toBe(95);
  });

  it('should fail when insufficient inventory', async () => {
    await expect(
      caller.orders.create({
        customerId: testCustomerId,
        items: [
          { productId: 'test-product-789', quantity: 200, price: 100 }
        ]
      })
    ).rejects.toThrow('Insufficient inventory');
  });
});
```

### Integration Test Best Practices

**1. Use Test Database**
```typescript
// .env.test
DATABASE_URL="postgresql://user:pass@localhost:5432/test_db"
```

**2. Clean Test Data After Each Test**
```typescript
afterEach(async () => {
  // Delete in reverse foreign key order
  await prisma.orderItem.deleteMany({ where: { orderId: testOrderId } });
  await prisma.order.deleteMany({ where: { id: testOrderId } });
});
```

**3. Test Error Cases**
```typescript
it('should handle database constraint violations', async () => {
  await expect(
    prisma.order.create({ data: { customerId: 'non-existent' } })
  ).rejects.toThrow('Foreign key constraint');
});
```

**4. Use Factory Functions for Test Data**
```typescript
// tests/factories/order-factory.ts
export async function createTestOrder(overrides = {}) {
  return await prisma.order.create({
    data: {
      userId: 'test-user',
      customerId: 'test-customer',
      total: 100,
      status: 'pending',
      ...overrides
    }
  });
}
```

---

## 2.1 Router Contract Validation (Integration Test Prerequisite)

### CRITICAL: Verify Router Methods Exist BEFORE Writing Tests

**Why This Matters**: Tests written without verifying router methods exist cause "No procedure found on path" errors. This wastes significant debugging time.

### The 4-Step Verification Process

Before writing ANY integration test:

```typescript
/**
 * STEP 1: Read Actual Router File
 * ================================
 */
// Terminal command:
cat src/server/api/routers/my-router.ts | grep -A2 "export const"

/**
 * STEP 2: Document Available Methods in Test Header
 * ==================================================
 */

/**
 * Integration Tests: My Router
 *
 * ROUTER METHODS VERIFIED (date)
 * Source: src/server/api/routers/my-router.ts
 *
 * Available Methods:
 * - method1(params) - Description
 * - method2(params) - Description
 *
 * Methods NOT Available:
 * - create() - Does NOT exist (use other router instead)
 */

/**
 * STEP 3: Run Automated Validation
 * =================================
 */
npm run validate:router-contracts

/**
 * STEP 4: Commit Tests Immediately
 * =================================
 */
git add tests/integration/
git commit -m "test(integration): add router lifecycle tests"
```

### Common API Mismatches

```typescript
// WRONG - Assumed method name
const result = await caller.myRouter.create({ name: 'Test' });
// Error: No procedure found on path 'myRouter,create'

// CORRECT - Verified method name
const result = await caller.myRouter.executeAction({
  actionId: existingId,
  context: { trigger: 'manual' }
});
```

---

## 3. E2E Testing (5% of Tests)

### Critical Test Paths

| # | Test | Coverage |
|---|------|----------|
| 1 | Authentication | Login, logout, session persistence |
| 2 | Admin Access | Admin portal access control |
| 3 | Order Creation | End-to-end order flow |
| 4 | Payment Processing | Payment integration |
| 5 | Document Upload | File upload/download |
| 6 | Search | Global search functionality |

### When to Add E2E Tests

**DO add for:**
- Critical revenue-generating flows (checkout, payment)
- Security-critical paths (authentication, authorization)
- Cross-system integrations (payment gateways, APIs)
- Compliance-required workflows (audit trails)

**DO NOT add for:**
- Features covered by unit/integration tests
- UI styling or layout changes
- Admin-only features (unless security-critical)

### E2E Best Practices

**1. Keep Tests Independent**
```typescript
// WRONG - Tests depend on each other
test('create order', async ({ page }) => { /* ... */ });
test('view order', async ({ page }) => {
  // Uses order from previous test (BRITTLE!)
});

// CORRECT - Self-contained
test('view order', async ({ page }) => {
  const orderId = await createTestOrder();
  await page.goto(`/orders/${orderId}`);
});
```

**2. Use Page Object Pattern**
```typescript
export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/auth/login');
  }

  async login(email: string, password: string) {
    await this.page.fill('[name="email"]', email);
    await this.page.fill('[name="password"]', password);
    await this.page.click('button[type="submit"]');
  }
}
```

**3. Wait for Network**
```typescript
// WRONG
await page.click('button');
await expect(page.locator('.result')).toBeVisible();

// CORRECT
await page.click('button');
await page.waitForLoadState('networkidle');
await expect(page.locator('.result')).toBeVisible();
```

---

## 4. Test Data Management

### Mock Data Strategies

| Strategy | Use Case | Example |
|----------|----------|---------|
| Inline mocks | Unit tests | `{ name: 'John', email: 'john@example.com' }` |
| Factory functions | Integration tests | `createTestUser({ email: 'specific@test.com' })` |
| Database seeding | E2E tests | `seedTestData()` in beforeAll |

### Test Isolation

```typescript
// Use unique test IDs
const testId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Clean up after each test
afterEach(async () => {
  await prisma.order.deleteMany({ where: { userId: testId } });
});

// WRONG - Shared state
let sharedOrder: Order;
beforeEach(() => { sharedOrder = createOrder(); });

// CORRECT - Each test creates its own
it('should update order', () => {
  const order = createOrder();
  // Test with this order
});
```

---

## 5. Development Workflow

### Pre-Commit Checks

```json
{
  "lint-staged": {
    "*.{ts,tsx}": [
      "npm run test -- --related --run",
      "npm run type-check",
      "npm run lint --fix"
    ]
  }
}
```

### Local Development

```bash
# Before starting work
git pull origin main && npm install && npm run test

# During development
npm run test -- --watch

# Before committing
npm run test && npm run type-check && npm run lint

# Before pushing
npm run build
```

---

## 6. Common Testing Patterns

### Testing Async Functions
```typescript
it('should fetch data', async () => {
  const result = await fetchUser('user-123');
  expect(result.email).toBe('test@example.com');
});
```

### Testing Error Handling
```typescript
it('should throw for invalid input', async () => {
  await expect(createOrder({ items: [] }))
    .rejects.toThrow('Order must have at least one item');
});
```

### Testing with Mocks
```typescript
import { vi } from 'vitest';

it('should call external API', async () => {
  const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  global.fetch = mockFetch;

  await sendEmail('test@example.com', 'Hello');

  expect(mockFetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/email'),
    expect.objectContaining({ method: 'POST' })
  );
});
```

### Testing React Components
```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

it('should submit form', async () => {
  const handleSubmit = vi.fn();
  render(<LoginForm onSubmit={handleSubmit} />);

  await userEvent.type(screen.getByLabelText('Email'), 'test@example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'password123');
  await userEvent.click(screen.getByRole('button', { name: /submit/i }));

  expect(handleSubmit).toHaveBeenCalledWith({
    email: 'test@example.com',
    password: 'password123'
  });
});
```

---

## 7. Troubleshooting

| Issue | Solution |
|-------|---------|
| Tests timing out | Increase timeout: `{ timeout: 10000 }` or globally in `vitest.config.ts` |
| Database tests failing | Clean database: `await prisma.$executeRaw\`TRUNCATE TABLE orders CASCADE\`` |
| Flaky E2E tests | Use `toPass` with retry: `await expect(async () => { ... }).toPass({ timeout: 5000 })` |

---

## Quick Reference

| Scenario | Test Type | Location |
|----------|-----------|----------|
| Business logic function | Unit | `src/__tests__/` |
| React component behavior | Unit | `src/__tests__/components/` |
| tRPC endpoint | Integration | `tests/integration/routers/` |
| Database transaction | Integration | `tests/integration/database/` |
| Login flow | E2E | `tests/e2e/critical/` |
| Payment processing | E2E | `tests/e2e/critical/` |

```bash
npm run test              # All unit + integration tests
npm run test -- --watch   # Watch mode
npm run test:e2e          # E2E tests
npm run type-check        # TypeScript validation
npm run build             # Verify production build
```

---

**Document Status**: ACTIVE
**Compliance**: Mandatory testing pyramid enforcement
