# Form Field Patterns

**Purpose**: Form patterns for semantic TextField types, PhoneInputField, AddressForm, react-hook-form + Zod setup, register() vs Controller, edit forms, submission patterns.

**When to Read**: Before creating or modifying forms.

---

## Sections
| Section | Line | Description |
|---------|------|-------------|
| Overview | ~15 | Purpose, consistency goals, accessibility compliance |
| Semantic TextField Usage | ~25 | Mandatory TextField semantic types table |
| Phone Input Pattern | ~117 | PhoneInputField for international phone numbers |
| Complete Form Example | ~192 | Full form example combining all patterns |
| Field-Specific Patterns | ~304 | Per-field guidance: money, percent, date, URL |
| Address Forms | ~430 | AddressForm component usage |
| Data Storage Standards | ~453 | How to normalize and store form data |
| Verification Checklist | ~468 | Pre-submit checklist for form implementations |
| React Hook Form + Zod Standard Patterns | ~483 | Setup, register(), Controller, reset(), watch(), submission |
| Migration Checklist | ~850 | Steps to migrate legacy forms to standard patterns |
| Related Documentation | ~871 | Links to related pattern docs |

## Overview

This document establishes the standard patterns for form fields across your application. Following these patterns ensures:
- Consistent UX across all forms
- Proper data normalization and validation
- Mobile-optimized keyboard experiences
- Accessibility compliance

---

## Semantic TextField Usage

### [x] MANDATORY - Use TextField with Semantic Types

**Always use TextField from `@/components/common/form/TextField.tsx` with semantic types for:**

| Field Type | Component | Use For |
|------------|-----------|---------|
| First Name | `TextField type="firstName"` | Person first names |
| Last Name | `TextField type="lastName"` | Person last names |
| Email | `TextField type="email"` | Email addresses |
| **Phone** | **`PhoneInputField`** | Phone numbers (international) |
| Company | `TextField type="company"` | Company/organization names |
| URL | `TextField type="url"` | Website URLs |
| Money | `TextField type="money"` | Currency amounts |
| Percent | `TextField type="percent"` | Percentage values |
| Date | `TextField type="date"` | Date values |

> **Note**: Phone fields use `PhoneInputField` (not TextField) for international support. See [Phone Input Pattern](#phone-input-pattern) below.

### [X] WRONG - Raw Input for Semantic Data

```tsx
// [X] DO NOT USE - Raw Input without semantic handling
<Input
  type="text"
  name="first_name"
  placeholder="First name"
/>

<Input
  type="email"
  name="email"
  placeholder="Email"
/>

<Input
  type="tel"
  name="phone"
  placeholder="Phone"
/>
```

**This is WRONG because:**
- No auto-formatting or normalization
- No mobile keyboard optimization
- No inline validation or success states
- Inconsistent UX across forms

### [x] CORRECT - Semantic TextField

```tsx
// [x] CORRECT - Use TextField with semantic types
import { TextField } from '@/components/common/form/TextField';

<TextField
  type="firstName"
  name="first_name"
  label="First Name"
  required
  register={register}
  errors={errors}
  setValue={setValue}
  watch={watch}
  showSuccess
/>

<TextField
  type="email"
  name="email"
  label="Email Address"
  required
  register={register}
  errors={errors}
  setValue={setValue}
  watch={watch}
  showSuccess
/>

<PhoneInputField
  name="phone"
  label="Phone Number"
  defaultCountry="US"
  errors={errors}
  setValue={setValue}
  watch={watch}
  showSuccess
/>
```

---

## Phone Input Pattern

### [x] MANDATORY - Use PhoneInputField for Phone Numbers

International phone support with country code selection.

| Aspect | Value |
|--------|-------|
| Component | `PhoneInputField` |
| Location | `@/components/common/form/PhoneInputField.tsx` |
| Purpose | International phone input with country selector |
| Storage Format | E.164 (`+12025551234`) |

### [X] WRONG - TextField type="phone" (Deprecated)

```tsx
// [X] DEPRECATED - US/Canada only, no international support
<TextField
  type="phone"
  name="phone"
  label="Phone Number"
  icon={Phone}
  formatAsYouType
  register={register}
  errors={errors}
  setValue={setValue}
  watch={watch}
/>
```

**This is WRONG because:**
- Only supports US/Canada phone formatting
- No country code selection
- Cannot handle international customers
- Not E.164 compatible for Twilio

### [x] CORRECT - PhoneInputField

```tsx
// [x] CORRECT - Full international support
import { PhoneInputField } from '@/components/common/form/PhoneInputField';

<PhoneInputField
  name="phone"
  label="Phone Number"
  defaultCountry="US"
  errors={errors}
  setValue={setValue}
  watch={watch}
  showSuccess
/>
```

**Benefits:**
- Country selector with flags and dial codes
- Auto-formatting per selected country
- Stores in E.164 format for Twilio compatibility
- Uses libphonenumber-js for accurate validation

### PhoneInputField Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Field name for react-hook-form |
| `label` | string | Yes | Label text |
| `defaultCountry` | CountryCode | No | Default country (default: 'US') |
| `errors` | FieldErrors | Yes | react-hook-form errors |
| `setValue` | UseFormSetValue | Yes | react-hook-form setValue |
| `watch` | UseFormWatch | Yes | react-hook-form watch |
| `showSuccess` | boolean | No | Show green check when valid |
| `required` | boolean | No | Mark field as required |
| `disabled` | boolean | No | Disable the field |

---

## Complete Form Example

### Standard Contact Form Pattern

```tsx
'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { TextField } from '@/components/common/form/TextField';
import { PhoneInputField } from '@/components/common/form/PhoneInputField';
import { Button } from '@/components/ui/button';

const contactSchema = z.object({
  first_name: z.string().min(1, 'First name is required'),
  last_name: z.string().optional(),
  email: z.string().email('Valid email required'),
  phone: z.string().optional(),
  company: z.string().optional(),
  website: z.string().url().optional().or(z.literal('')),
});

type ContactFormData = z.infer<typeof contactSchema>;

export function ContactForm({ onSubmit }: { onSubmit: (data: ContactFormData) => void }) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ContactFormData>({
    resolver: zodResolver(contactSchema),
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <TextField
          type="firstName"
          name="first_name"
          label="First Name"
          required
          register={register}
          errors={errors}
          setValue={setValue}
          watch={watch}
          showSuccess
        />
        <TextField
          type="lastName"
          name="last_name"
          label="Last Name"
          register={register}
          errors={errors}
          setValue={setValue}
          watch={watch}
        />
      </div>

      <TextField
        type="email"
        name="email"
        label="Email Address"
        required
        register={register}
        errors={errors}
        setValue={setValue}
        watch={watch}
        showSuccess
      />

      <PhoneInputField
        name="phone"
        label="Phone Number"
        defaultCountry="US"
        errors={errors}
        setValue={setValue}
        watch={watch}
        showSuccess
      />

      <TextField
        type="company"
        name="company"
        label="Company"
        register={register}
        errors={errors}
        setValue={setValue}
        watch={watch}
      />

      <TextField
        type="url"
        name="website"
        label="Website"
        placeholder="https://example.com"
        register={register}
        errors={errors}
        setValue={setValue}
        watch={watch}
      />

      <Button type="submit">Save Contact</Button>
    </form>
  );
}
```

---

## Field-Specific Patterns

### Phone Number Fields

```tsx
// International phone with country selector
import { PhoneInputField } from '@/components/common/form/PhoneInputField';

<PhoneInputField
  name="phone"
  label="Phone Number"
  defaultCountry="US"   // Default country (supports all countries)
  showSuccess           // Shows checkmark when valid
  errors={errors}
  setValue={setValue}
  watch={watch}
/>
```

**Behavior:**
- Country selector dropdown with flags and dial codes
- Auto-formats per selected country as user types
- Stores in E.164 format (`+15551234567`) for Twilio compatibility
- Shows validation checkmark when valid
- Uses libphonenumber-js for accurate validation

### Email Fields

```tsx
// Email with validation feedback
<TextField
  type="email"
  name="email"
  label="Email Address"
  required
  showSuccess
  register={register}
  errors={errors}
  setValue={setValue}
  watch={watch}
/>
```

**Behavior:**
- `inputMode="email"` for mobile email keyboard
- `autoCapitalize="none"` prevents unwanted caps
- Normalizes to lowercase and trimmed on blur
- Validates RFC 5322 pattern

### Name Fields

```tsx
// First name with auto-capitalize
<TextField
  type="firstName"
  name="first_name"
  label="First Name"
  required
  register={register}
  errors={errors}
  setValue={setValue}
  watch={watch}
/>

// Last name with smart capitalization
<TextField
  type="lastName"
  name="last_name"
  label="Last Name"
  register={register}
  errors={errors}
  setValue={setValue}
  watch={watch}
/>
```

**Behavior:**
- `autoCapitalize="words"` for mobile
- Smart capitalization handles: McDonald, O'Brien, de la Cruz
- Normalizes on blur

### Money Fields

```tsx
// Currency input with prefix
<TextField
  type="money"
  name="price"
  label="Price"
  prefix="$"
  register={register}
  errors={errors}
  setValue={setValue}
  watch={watch}
/>
```

**Behavior:**
- `inputMode="decimal"` for numeric keyboard with decimal
- Displays `$` prefix
- Accepts: `1234.56`, `1,234.56`, `$1,234.56`
- Stores as decimal number

### URL Fields

```tsx
// URL with protocol normalization
<TextField
  type="url"
  name="website"
  label="Website"
  placeholder="https://example.com"
  register={register}
  errors={errors}
  setValue={setValue}
  watch={watch}
/>
```

**Behavior:**
- `inputMode="url"` for URL keyboard
- Auto-adds `https://` if missing on blur
- Validates URL structure

---

## Address Forms

### [x] CORRECT - Use AddressForm Component

```tsx
import { AddressForm, type AddressFormData } from '@/components/crm/AddressForm';

// In your form
<AddressForm
  data={addressData}
  onChange={setAddressData}
  enableAutoDetect  // ZIP auto-fills city/state for US/Canada
/>
```

**Baymard UX Pattern:**
- Country field FIRST (determines ZIP format)
- ZIP code field BEFORE City/State
- Auto-detection fills City/State from ZIP
- Reduces typos and improves completion speed

---

## Data Storage Standards

| Field Type | Storage Format | Example |
|------------|---------------|---------|
| Phone | E.164 | `+15551234567` |
| Email | Lowercase, trimmed | `john@example.com` |
| First Name | Title case | `John` |
| Last Name | Smart title case | `McDonald` |
| Company | Trimmed | `Acme Corp` |
| URL | Full with protocol | `https://example.com` |
| Money | Decimal | `1234.56` |
| Percent | Decimal fraction | `0.0825` (for 8.25%) |

---

## Verification Checklist

When creating or updating forms:
- [ ] All name fields use `type="firstName"` or `type="lastName"`
- [ ] All email fields use `type="email"`
- [ ] All phone fields use `PhoneInputField` (NOT TextField type="phone")
- [ ] All company fields use `type="company"`
- [ ] All URL fields use `type="url"`
- [ ] All money fields use `type="money"` with appropriate prefix
- [ ] `setValue` and `watch` props passed for normalization
- [ ] `showSuccess` enabled for required fields
- [ ] Address forms use `AddressForm` component

---

## React Hook Form + Zod Standard Patterns

All forms MUST use react-hook-form with Zod validation.

### [x] MANDATORY - Form Setup Pattern

```tsx
'use client';

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

// 1. Define Zod schema with proper validation
const myFormSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().min(1, 'Email is required').email('Please enter a valid email'),
  description: z.string(),  // Optional field (no .min())
  status: z.enum(['draft', 'active', 'archived']),
  is_active: z.boolean(),
});

// 2. Infer TypeScript type from schema
type MyFormData = z.infer<typeof myFormSchema>;

// 3. Setup useForm with zodResolver
const {
  register,
  handleSubmit,
  control,        // For Controller components
  reset,          // For populating edit forms
  watch,          // For reactive values in UI
  formState: { errors, isSubmitting },
} = useForm<MyFormData>({
  resolver: zodResolver(myFormSchema),
  defaultValues: {
    name: '',
    email: '',
    description: '',
    status: 'draft',
    is_active: true,
  },
});
```

### [X] WRONG - Legacy useState/formData Pattern

```tsx
// [X] DO NOT USE - Legacy pattern with individual or object useState
const [formData, setFormData] = useState({
  name: '',
  email: '',
});
const [isSubmitting, setIsSubmitting] = useState(false);

// Manual field updates
const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
  setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
};

// Manual submit handling
const handleSubmit = async () => {
  setIsSubmitting(true);
  // ... validation, submission
  setIsSubmitting(false);
};
```

**This is WRONG because:**
- No built-in validation or error handling
- Manual state synchronization
- Verbose boilerplate code
- No TypeScript inference from schema

### Native Input Elements - Use register()

For Input, Textarea, and other native form elements:

```tsx
// Input with register()
<div className="space-y-2">
  <Label htmlFor="name">Name *</Label>
  <Input
    id="name"
    {...register('name')}
    placeholder="Enter name"
    className={errors.name ? 'border-destructive' : ''}
  />
  {errors.name && (
    <p className="text-xs text-destructive">{errors.name.message}</p>
  )}
</div>

// Textarea with register()
<Textarea
  id="description"
  {...register('description')}
  placeholder="Enter description..."
  rows={3}
/>
```

### Non-Native Elements - Use Controller

For Select, Switch, Checkbox, and custom components:

```tsx
// Select with Controller
<Controller
  name="status"
  control={control}
  render={({ field }) => (
    <Select value={field.value} onValueChange={field.onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Select status" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="draft">Draft</SelectItem>
        <SelectItem value="active">Active</SelectItem>
        <SelectItem value="archived">Archived</SelectItem>
      </SelectContent>
    </Select>
  )}
/>

// Switch with Controller
<Controller
  name="is_active"
  control={control}
  render={({ field }) => (
    <Switch
      id="is_active"
      checked={field.value}
      onCheckedChange={field.onChange}
    />
  )}
/>

// Checkbox with Controller
<Controller
  name="agree_terms"
  control={control}
  render={({ field }) => (
    <Checkbox
      checked={field.value}
      onCheckedChange={field.onChange}
    />
  )}
/>
```

### Edit Forms - Use reset() in useEffect

For forms that load existing data:

```tsx
// Fetch existing data
const { data: item, isLoading } = api.items.getById.useQuery(
  { id },
  { enabled: !!id }
);

// Populate form when data loads
useEffect(() => {
  if (item) {
    reset({
      name: item.name || '',
      email: item.email || '',
      description: item.description || '',
      status: (item.status as MyFormData['status']) || 'draft',
      is_active: item.is_active ?? true,
    });
  }
}, [item, reset]);
```

### Reactive Values - Use watch()

For displaying form values in UI or validation:

```tsx
// Watch specific field for UI updates
const name = watch('name');

// Use in conditional rendering or validation
const isFormValid = name.trim() && email.trim();

// In submit button
<Button type="submit" disabled={!isFormValid || isSubmitting}>
  {isSubmitting ? 'Saving...' : 'Save'}
</Button>
```

### UI-Only State - Keep Separate

For transient UI state like tag/capability inputs:

```tsx
// Tags that are added via Enter key - keep as separate useState
const [tags, setTags] = useState<string[]>([]);
const [tagInput, setTagInput] = useState('');

const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter' && tagInput.trim()) {
    e.preventDefault();
    if (!tags.includes(tagInput.trim())) {
      setTags([...tags, tagInput.trim()]);
    }
    setTagInput('');
  }
};

// Note: Tags are NOT part of the Zod schema - they're managed separately
// Include tags in the mutation call, not the form data
```

### Form Submission Pattern

```tsx
// Name the handler 'onSubmit' to avoid conflict with handleSubmit from useForm
const onSubmit = (data: MyFormData) => {
  mutation.mutate({
    name: data.name.trim(),
    email: data.email.trim(),
    description: data.description.trim() || null,
    status: data.status,
    is_active: data.is_active,
  });
};

// In JSX - wrap with handleSubmit from useForm
<form onSubmit={handleSubmit(onSubmit)}>
  {/* form fields */}
</form>
```

### Complete Edit Form Example

```tsx
'use client';

import { use, useState, useEffect, Suspense } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api } from '@/lib/api/client';

const templateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
  template_type: z.enum(['email', 'sms', 'notification']),
  is_active: z.boolean(),
});

type TemplateFormData = z.infer<typeof templateSchema>;

function TemplateEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [isEditing, setIsEditing] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<TemplateFormData>({
    resolver: zodResolver(templateSchema),
    defaultValues: {
      name: '',
      description: '',
      template_type: 'email',
      is_active: true,
    },
  });

  const name = watch('name');

  const { data: template, isLoading, refetch } = api.templates.getById.useQuery(
    { id },
    { enabled: !!id }
  );

  const updateMutation = api.templates.update.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      refetch();
    },
  });

  useEffect(() => {
    if (template) {
      reset({
        name: template.name || '',
        description: template.description || '',
        template_type: (template.template_type as TemplateFormData['template_type']) || 'email',
        is_active: template.is_active ?? true,
      });
    }
  }, [template, reset]);

  const onSubmit = (data: TemplateFormData) => {
    updateMutation.mutate({
      id,
      data: {
        name: data.name,
        description: data.description || null,
        template_type: data.template_type,
        is_active: data.is_active,
      },
    });
  };

  const handleCancel = () => {
    if (template) {
      reset({
        name: template.name || '',
        description: template.description || '',
        template_type: (template.template_type as TemplateFormData['template_type']) || 'email',
        is_active: template.is_active ?? true,
      });
    }
    setIsEditing(false);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Input {...register('name')} className={errors.name ? 'border-destructive' : ''} />
      {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}

      <Textarea {...register('description')} />

      <Controller
        name="template_type"
        control={control}
        render={({ field }) => (
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="sms">SMS</SelectItem>
              <SelectItem value="notification">Notification</SelectItem>
            </SelectContent>
          </Select>
        )}
      />

      <Controller
        name="is_active"
        control={control}
        render={({ field }) => (
          <Switch checked={field.value} onCheckedChange={field.onChange} />
        )}
      />

      <Button type="button" variant="outline" onClick={handleCancel}>Cancel</Button>
      <Button type="submit" disabled={!name || isSubmitting}>
        {isSubmitting ? 'Saving...' : 'Save'}
      </Button>
    </form>
  );
}
```

---

## Migration Checklist

When migrating forms from useState/formData to react-hook-form:

- [ ] Import useForm, Controller, zodResolver, z
- [ ] Create Zod schema with all form fields
- [ ] Create TypeScript type with z.infer
- [ ] Replace useState with useForm setup
- [ ] Set defaultValues for all fields
- [ ] Replace manual setFormData with register() for native inputs
- [ ] Use Controller for Select, Switch, Checkbox
- [ ] Rename handleSubmit to onSubmit (avoid conflict)
- [ ] Wrap form with handleSubmit(onSubmit)
- [ ] Replace setIsSubmitting with isSubmitting from formState
- [ ] For edit forms: use reset() in useEffect
- [ ] For reactive values: use watch()
- [ ] Keep UI-only state (tags, etc.) as separate useState
- [ ] Add error display with errors.fieldName.message

---

## Related Documentation

- **Component**: `src/components/common/form/TextField.tsx`
- **Formatting Functions**: `src/lib/formatting/fields.ts`
- **Display Patterns**: `patterns/display-patterns.md`
- **UI Patterns**: `patterns/ui-patterns.md`

---

**Status**: MANDATORY
**Compliance**: All forms MUST follow these patterns
