# UI Patterns

**Purpose**: Layout, theming, component selection, and UI quality standards.

**When to Read**: Before creating or modifying UI components, pages, or styles.

---

## Layout Architecture

### Page Container Pattern

```
page-container (no padding - just width + centering)
└── main-content (10px padding)
    ├── Header section
    ├── Content area
    └── Footer/actions
```

```typescript
// Standard page layout
export default function MyPage() {
  return (
    <div className="page-container">
      <div className="main-content">
        <h1 className="text-2xl font-bold">Page Title</h1>
        {/* Page content */}
      </div>
    </div>
  );
}
```

**Rule**: ALL pages MUST use the `page-container` class. Never create custom width/centering.

### Mobile Chat Layout

For full-height mobile layouts (chat, messaging):

```typescript
// Use sm:page-container for mobile-first full height
<div className="sm:page-container">
  <div className="main-content h-full">
    {/* Full-height content */}
  </div>
</div>
```

---

## Dark Mode

### Theme-Aware Components

```typescript
import { useTheme } from 'next-themes';

function Logo() {
  const { resolvedTheme } = useTheme();
  return (
    <Image
      src={resolvedTheme === 'dark' ? '/logo-dark.png' : '/logo-light.png'}
      alt="Logo"
    />
  );
}
```

### WCAG AA Contrast

When using colored backgrounds in dark mode, ensure text contrast meets WCAG AA (4.5:1 ratio):

```css
/* WRONG - Low contrast in dark mode */
.badge-success {
  background-color: hsl(142 76% 36%);
  color: hsl(142 76% 36%); /* Same hue, no contrast */
}

/* CORRECT - High contrast */
.badge-success {
  background-color: hsl(142 76% 36% / 0.2);
  color: var(--color-success-foreground);
}
```

---

## Semantic CSS Color Classes

Use semantic color classes instead of hardcoded values:

```css
/* Badge variants */
.badge-primary { ... }
.badge-success { ... }
.badge-warning { ... }
.badge-error { ... }
.badge-info { ... }

/* Stats text */
.stats-text-success { color: var(--color-success); }
.stats-text-warning { color: var(--color-warning); }
.stats-text-error { color: var(--color-error); }
```

**Rule**: NEVER use hardcoded hex/rgb colors. Always use CSS variables or semantic classes.

---

## Suspense Boundaries

ALL pages using `use(params)` or `useSearchParams()` MUST be wrapped in Suspense:

```typescript
import { Suspense } from 'react';
import { LoadingState } from '@/components/common/LoadingState';

export default function Page() {
  return (
    <Suspense fallback={<LoadingState />}>
      <PageContent />
    </Suspense>
  );
}

function PageContent() {
  const searchParams = useSearchParams();
  // ...
}
```

Without Suspense, static generation fails with cryptic errors.

---

## Null Guards

Always guard nullable values before calling string methods:

```typescript
// WRONG - TypeError if status is null
<span>{status.replace(/_/g, ' ')}</span>

// CORRECT - Null guard
<span>{(status || "pending").replace(/_/g, ' ')}</span>

// CORRECT - Optional chaining with fallback
<span>{status?.replace(/_/g, ' ') ?? 'Pending'}</span>
```

---

## Select.Item Value

NEVER use `value=""` on Select.Item — causes React crash:

```typescript
// WRONG - React crash
<SelectItem value="">All</SelectItem>

// CORRECT - Use __none__ placeholder
<SelectItem value="__none__">All</SelectItem>
```

---

## Toast Standardization

Use Sonner for all toast notifications:

```typescript
import { toast } from 'sonner';

// Success
toast.success('Changes saved');

// Error with description
toast.error('Failed to save', {
  description: 'Please check your connection and try again'
});

// Promise toast
toast.promise(saveMutation.mutateAsync(data), {
  loading: 'Saving...',
  success: 'Saved!',
  error: 'Failed to save'
});
```

**Setup**: Ensure `<Toaster />` from Sonner is in your root layout/Providers.

---

## Sheet Pattern (CR-40)

ALL overlays MUST use `Sheet` (slide-out panel), NEVER `Dialog`:

```typescript
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

<Sheet open={isOpen} onOpenChange={setIsOpen}>
  <SheetContent>
    <SheetHeader>
      <SheetTitle>Edit Contact</SheetTitle>
      <SheetDescription>
        Update contact information
      </SheetDescription>
    </SheetHeader>
    {/* Form content */}
  </SheetContent>
</Sheet>
```

**Exception**: `AlertDialog` is allowed ONLY for destructive confirmations (delete, discard changes).

### Close Button Pattern

```typescript
// Ensure close button has data attribute for testing
<SheetContent>
  <button data-close-button onClick={() => setIsOpen(false)}>
    <X className="h-4 w-4" />
  </button>
  {/* Content */}
</SheetContent>
```

---

## DataTable Component

For tabular data, use the DataTable component:

```typescript
import { DataTable } from '@/components/common/DataTable';

const columns = [
  {
    accessorKey: 'name',
    header: 'Name',
  },
  {
    accessorKey: 'email',
    header: 'Email',
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
];

<DataTable
  columns={columns}
  data={contacts}
  searchKey="name"
  searchPlaceholder="Search contacts..."
/>
```

---

## Touch/Tablet Patterns

### Stylus Events

```typescript
// WRONG - Unreliable on tablets
<canvas onClick={handleDraw} />

// CORRECT - Pointer events for stylus support
<canvas
  onPointerDown={handlePointerDown}
  onPointerMove={handlePointerMove}
  onPointerUp={handlePointerUp}
/>
```

**Rule**: Min 44px touch targets for all interactive elements.

### Pinch-to-Zoom

```typescript
// Detect 2-finger gestures
const handleTouchStart = (e: TouchEvent) => {
  if (e.touches.length === 2) {
    // Set pointer-events-none on canvas to allow native zoom
    canvasRef.current?.style.setProperty('pointer-events', 'none');
  }
};
```

---

## Accessibility

### No Zoom Disable

NEVER disable user zoom — breaks WCAG accessibility:

```html
<!-- WRONG -->
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />

<!-- CORRECT -->
<meta name="viewport" content="width=device-width, initial-scale=1" />
```

### Proper Heading Hierarchy

```typescript
// CORRECT - Sequential heading levels
<h1>Page Title</h1>
<h2>Section</h2>
<h3>Subsection</h3>

// WRONG - Skipping levels
<h1>Page Title</h1>
<h3>Subsection</h3>  {/* Skipped h2 */}
```

---

## Design System

### Token Reference

Before CSS work, read the token reference for available CSS variables:

| Category | Prefix | Example |
|----------|--------|---------|
| Colors | `--color-` | `var(--color-primary)` |
| Spacing | `--spacing-` | `var(--spacing-4)` |
| Typography | `--font-` | `var(--font-sans)` |
| Radius | `--radius-` | `var(--radius-md)` |

### Token Audit

After CSS changes, run the token audit:

```bash
bash scripts/audit-design-tokens.sh
# Expected: Exit 0 (zero hardcoded colors)
```

---

## Quick Reference

| Rule | Pattern | Error if Violated |
|------|---------|-------------------|
| Select.Item value | Never `value=""`, use `__none__` | React crash |
| Null guards | `(status \|\| "pending").replace()` | TypeError |
| Page layout | Always use `page-container` class | Inconsistent gaps |
| Stylus events | `onPointerDown` not `onClick` | Unreliable on tablets |
| NO Modal Dialogs | Use `Sheet` for overlays; `AlertDialog` only for destructive | CR-40 violation |
| No user-scalable=no | Never disable zoom | WCAG violation |
| Suspense boundaries | Wrap `use(params)` pages | Static generation fails |

---

**Document Status**: ACTIVE
**Compliance**: Mandatory for all UI work
