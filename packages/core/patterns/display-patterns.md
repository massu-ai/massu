# Display Patterns

**Purpose**: Centralized formatting functions and display conventions for data presentation.

**When to Read**: Before displaying formatted data (currency, phone numbers, dates, names, file sizes).

---

## Centralized Formatters

### Canonical Formatting Functions

All formatting MUST use centralized functions from `@/lib/formatting/fields`:

```typescript
import {
  formatMoney,
  formatPhone,
  formatDate,
  formatFullName,
  formatFileSize,
} from '@/lib/formatting/fields';
```

### Function Reference

| Function | Input | Output | Notes |
|----------|-------|--------|-------|
| `formatMoney(amount)` | `number` | `$1,234.56` | US currency, 2 decimal places |
| `formatPhone(phone)` | `string` (E.164) | `(555) 123-4567` | US format from E.164 |
| `formatDate(date)` | `Date \| string` | `Jan 15, 2026` | Medium format |
| `formatFullName(first, last)` | `string, string` | `John Doe` | Null-safe, trims whitespace |
| `formatFileSize(bytes)` | `number` | `1.5 MB` | Auto-scales units |

### Usage Examples

```typescript
// Currency
<span>{formatMoney(order.total)}</span>
// Output: "$1,234.56"

// Phone
<span>{formatPhone(contact.phone)}</span>
// Output: "(555) 123-4567"

// Date
<span>{formatDate(order.created_at)}</span>
// Output: "Jan 15, 2026"

// Name
<span>{formatFullName(user.first_name, user.last_name)}</span>
// Output: "John Doe"

// File size
<span>{formatFileSize(file.size)}</span>
// Output: "1.5 MB"
```

---

## formatFileSize Pattern

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
import { formatFileSize } from '@/lib/formatting/fields';

<span>{formatFileSize(file.size)}</span>
```

---

## EditableField Component

For inline editing with type-appropriate display:

```typescript
import { EditableField } from '@/components/common/EditableField';

<EditableField
  label="Phone"
  value={contact.phone}
  type="phone"
  onSave={(value) => updateContact({ phone: value })}
/>
```

### Supported Types

| Type | Display | Edit Control |
|------|---------|-------------|
| `text` | Plain text | Input |
| `phone` | Formatted phone | PhoneInput |
| `email` | Email with link | Input type=email |
| `money` | Currency formatted | Input type=number |
| `date` | Formatted date | DatePicker |
| `select` | Selected label | Select dropdown |
| `textarea` | Multi-line text | Textarea |

---

## DataTable Column Type Handlers

When defining DataTable columns, use type-appropriate formatters:

```typescript
const columns = [
  {
    accessorKey: 'name',
    header: 'Name',
    cell: ({ row }) => formatFullName(row.original.first_name, row.original.last_name),
  },
  {
    accessorKey: 'phone',
    header: 'Phone',
    cell: ({ row }) => row.original.phone ? formatPhone(row.original.phone) : '—',
  },
  {
    accessorKey: 'total',
    header: 'Total',
    cell: ({ row }) => formatMoney(row.original.total),
  },
  {
    accessorKey: 'created_at',
    header: 'Created',
    cell: ({ row }) => formatDate(row.original.created_at),
  },
];
```

---

## International Formatting

For locale-aware formatting, use functions from `@/lib/i18n/formatting`:

```typescript
import {
  formatCurrency,
  formatNumber,
  formatRelativeTime,
} from '@/lib/i18n/formatting';

// Currency with locale
formatCurrency(1234.56, 'USD', 'en-US')  // "$1,234.56"
formatCurrency(1234.56, 'EUR', 'de-DE')  // "1.234,56 €"

// Relative time
formatRelativeTime(new Date('2026-01-14'))  // "2 days ago"
```

---

## Display Rules

| Rule | Pattern | Error if Violated |
|------|---------|-------------------|
| Always use centralized formatters | Import from `@/lib/formatting/fields` | Inconsistent formatting |
| Never inline format functions | Use canonical imports | Duplicate code, drift |
| Null-safe display | `value ?? '—'` for missing data | Blank cells confuse users |
| Consistent empty state | Use em dash `—` not empty string | Visual clarity |

---

## Related Documentation

- **Component Patterns**: `patterns/component-patterns.md`
- **Form Patterns**: `patterns/form-patterns.md`
- **UI Patterns**: `patterns/ui-patterns.md`

---

**Document Status**: ACTIVE
**Compliance**: Mandatory — all formatting must use centralized functions
