# Component Patterns

**Purpose**: Standard patterns for UI components, forms, search inputs, and common interactive elements.

**When to Read**: Before creating or modifying UI components.

---

## Toast Notifications

### Standard Pattern: Sonner

```typescript
// CORRECT - Use Sonner directly
import { toast } from 'sonner';

// Success
toast.success('Changes saved successfully');

// Error
toast.error('Failed to save changes');

// With description
toast.success('Contact created', {
  description: 'John Doe has been added to your contacts'
});

// Promise toast (loading → success/error)
toast.promise(mutation.mutateAsync(data), {
  loading: 'Saving...',
  success: 'Saved successfully',
  error: 'Failed to save'
});
```

### WRONG - Deprecated useToast Hook

```typescript
// WRONG - Legacy hook pattern, do NOT use
const { toast } = useToast();
toast({ title: 'Success', description: '...' });
```

**Why Sonner**: Single import, consistent API, auto-dismiss, better DX.

---

## Loading State

```typescript
import { LoadingState } from '@/components/common/LoadingState';

// In page or component
if (isLoading) {
  return <LoadingState />;
}

// With custom message
if (isLoading) {
  return <LoadingState message="Loading contacts..." />;
}
```

**Rule**: ALL loading states MUST use the `LoadingState` component. Never use raw spinners or "Loading..." text.

---

## Empty State

```typescript
import { EmptyState } from '@/components/common/EmptyState';

// Basic
if (data?.length === 0) {
  return (
    <EmptyState
      title="No contacts found"
      description="Add your first contact to get started"
      action={{
        label: "Add Contact",
        onClick: () => setIsCreating(true)
      }}
    />
  );
}
```

**Rule**: ALL empty states MUST use the `EmptyState` component with actionable guidance.

---

## Form Inputs

### Checkbox

```typescript
import { Checkbox } from '@/components/ui/checkbox';

<div className="flex items-center space-x-2">
  <Checkbox
    id="agree"
    checked={agreed}
    onCheckedChange={setAgreed}
  />
  <label htmlFor="agree" className="text-sm">
    I agree to the terms
  </label>
</div>
```

### Select

```typescript
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// CRITICAL: Never use value="" - causes React crash
// Use __none__ for "no selection" option
<Select value={status} onValueChange={setStatus}>
  <SelectTrigger>
    <SelectValue placeholder="Select status" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="__none__">All Statuses</SelectItem>
    <SelectItem value="active">Active</SelectItem>
    <SelectItem value="inactive">Inactive</SelectItem>
  </SelectContent>
</Select>
```

### DatePicker

```typescript
import { DatePicker } from '@/components/ui/date-picker';

<DatePicker
  date={selectedDate}
  onSelect={setSelectedDate}
  placeholder="Select date"
/>
```

---

## Search Input

```typescript
// Standard search input with consistent styling
<Input
  placeholder="Search..."
  value={searchQuery}
  onChange={(e) => setSearchQuery(e.target.value)}
  className="page-search-input"
/>
```

**Rule**: ALL search inputs MUST use the `page-search-input` class for consistent styling.

---

## Query Keys (React Query / tRPC)

```typescript
// CORRECT - Double brackets for tRPC query keys
queryKey: [['contacts', 'list']]

// WRONG - Single brackets
queryKey: ['contacts', 'list']  // Will not match tRPC invalidation
```

**Why**: tRPC wraps query keys in an additional array. Using single brackets means `queryClient.invalidateQueries()` won't match.

---

## Form Validation (Zod + react-hook-form)

```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email'),
  phone: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

const {
  register,
  handleSubmit,
  formState: { errors },
} = useForm<FormData>({
  resolver: zodResolver(schema),
});
```

**Rule**: ALL forms MUST use react-hook-form with Zod validation. See `patterns/form-patterns.md` for complete guide.

---

## ESLint Integration

Custom ESLint rules enforce component patterns:

| Rule | What It Catches |
|------|----------------|
| `no-deprecated-toast` | useToast() hook usage |
| `no-raw-loading` | Inline loading spinners instead of LoadingState |
| `no-empty-select-value` | `value=""` on Select.Item |
| `no-single-bracket-querykey` | Single bracket query keys |

### Detection Commands

```bash
# Check for deprecated toast usage
grep -rn "useToast" src/ --include="*.tsx" --include="*.ts"
# Expected: 0 matches (all should use sonner)

# Check for empty select values
grep -rn 'value=""' src/ --include="*.tsx"
# Expected: 0 matches

# Check for single bracket query keys
grep -rn "queryKey: \['" src/ --include="*.tsx" --include="*.ts"
# Expected: 0 matches (should be double brackets)
```

---

## Related Documentation

- **Form Patterns**: `patterns/form-patterns.md`
- **UI Patterns**: `patterns/ui-patterns.md`
- **Display Patterns**: `patterns/display-patterns.md`

---

**Document Status**: ACTIVE
**Compliance**: Mandatory for all component work
