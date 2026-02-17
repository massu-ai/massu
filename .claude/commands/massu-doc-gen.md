---
name: massu-doc-gen
description: Generate JSDoc comments, README sections, and API docs for undocumented code
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-doc-gen

# CS Doc Gen: Documentation Generation

## Objective

Scan the codebase for undocumented functions, modules, and exported types, then generate accurate JSDoc comments, README sections, and API reference docs. Only documentation is added — no logic is modified.

**Usage**: `/massu-doc-gen` (full scan) or `/massu-doc-gen [area]` (focused: jsdoc, readme, api, config)

---

## NON-NEGOTIABLE RULES

- **Documentation ONLY** — never change logic, only add or update comments and docs
- **Accuracy over completeness** — only document what the code actually does; never invent behavior
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** — incorrect existing docs found during scan MUST be corrected
- **Run type check after every file** — JSDoc tags must not introduce TS errors
- **Read before writing** — always read the full function before writing its doc

---

## STEP 1: INVENTORY

Enumerate all documentation gaps across the codebase.

### 1a. Undocumented Functions (packages/core)

```bash
# Functions and methods without a preceding JSDoc block
grep -n "^export function\|^export async function\|^  [a-zA-Z].*): " \
  packages/core/src/*.ts | grep -v "__tests__" | while IFS=: read file line content; do
  # Check if line above is */ (end of JSDoc)
  prev=$((line - 1))
  preceding=$(sed -n "${prev}p" "$file" 2>/dev/null)
  if [[ "$preceding" != *"*/"* && "$preceding" != *"// "* ]]; then
    echo "UNDOCUMENTED: $file:$line  $content"
  fi
done
```

### 1b. Exported Types Without Description

```bash
# Exported interfaces and types without a preceding JSDoc
grep -n "^export interface\|^export type\|^export enum" \
  packages/core/src/*.ts | grep -v "__tests__"
```

### 1c. Module-Level Doc Coverage

```bash
# Source modules without a top-of-file comment block
for f in packages/core/src/*.ts; do
  first_line=$(head -1 "$f")
  if [[ "$first_line" != "/**"* && "$first_line" != "//"* ]]; then
    echo "NO MODULE DOC: $f"
  fi
done
```

### 1d. Config Schema Coverage

```bash
# Config fields without description in massu.config.yaml
cat massu.config.yaml 2>/dev/null | head -80
```

### 1e. Package Modules Without JSDoc

```bash
# Package modules without JSDoc exports
for f in packages/core/src/*.ts; do
  if ! grep -q "@description\|/\*\*" "$f"; then
    echo "NO JSDOC: $f"
  fi
done
```

---

## STEP 2: ANALYSIS

For each undocumented item, read the source and classify the documentation needed:

```markdown
### Documentation Inventory

| File | Item | Type | Priority | Action |
|------|------|------|----------|--------|
| [file] | [name] | function/type/module/endpoint | HIGH/MED/LOW | ADD_JSDOC/ADD_COMMENT/UPDATE_DOC |
```

**Priority Rules:**
- HIGH: exported functions/types used by tools.ts or server.ts
- MED: internal utilities with complex behavior
- LOW: simple pass-through wrappers

---

## STEP 3: GENERATION

Apply documentation in order of priority. Read the entire function/type before writing docs.

### JSDoc Pattern for Functions

```typescript
/**
 * Brief one-line description of what this function does.
 *
 * @param paramName - Description of the parameter
 * @param anotherParam - Description with type context
 * @returns Description of the return value
 * @throws Description of error conditions, if any
 *
 * @example
 * const result = doSomething('input', { option: true });
 */
export function doSomething(paramName: string, anotherParam: Options): Result {
```

### JSDoc Pattern for Types / Interfaces

```typescript
/**
 * Brief description of what this type represents.
 * Include usage context if non-obvious.
 */
export interface MyType {
  /** Description of this field */
  fieldName: string;
  /** Description, including valid values if enum-like */
  status: 'active' | 'inactive';
}
```

### Module-Level Comment Pattern

```typescript
/**
 * [module-name] — One-sentence description of module purpose.
 *
 * Responsibilities:
 * - [Responsibility 1]
 * - [Responsibility 2]
 *
 * @module [module-name]
 */
```

### After Each File

```bash
# Verify no TypeScript errors introduced
cd packages/core && npx tsc --noEmit 2>&1
# MUST show same or fewer errors than baseline
```

---

## STEP 4: README / API REFERENCE

If `$ARGUMENTS` includes `readme` or `api`, generate structured docs:

### README Section Template

```markdown
## [Module Name]

[One-paragraph description of purpose and responsibilities.]

### Exported Functions

| Function | Parameters | Returns | Description |
|----------|------------|---------|-------------|
| `functionName(param)` | `param: Type` | `ReturnType` | Brief description |

### Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `configKey` | `string` | `"default"` | What this controls |

### Example

\`\`\`typescript
import { functionName } from './module-name.ts';
const result = functionName('input');
\`\`\`
```

### Config Schema Annotation

For `massu.config.yaml`, add inline comments for undocumented fields:

```yaml
# Brief description of this section
sectionName:
  # Description of this field. Valid values: foo | bar | baz. Default: foo.
  fieldName: value
```

---

## STEP 5: VERIFICATION

### Gate 1: Type Check (VR-TYPE)
```bash
cd packages/core && npx tsc --noEmit
# MUST show 0 errors (or <= baseline before docs were added)
```

### Gate 2: Pattern Scanner (VR-PATTERN)
```bash
bash scripts/massu-pattern-scanner.sh
# MUST exit 0
```

### Gate 3: All Tests (VR-TEST)
```bash
npm test
# Documentation changes MUST NOT affect test results
```

---

## COMPLETION REPORT

```markdown
## CS DOC GEN COMPLETE

### Coverage Summary

| Category | Before | After | Added |
|----------|--------|-------|-------|
| Documented functions | [N] | [N] | [+N] |
| Documented types/interfaces | [N] | [N] | [+N] |
| Modules with module-level doc | [N] | [N] | [+N] |
| API endpoints with description | [N] | [N] | [+N] |
| Config fields with annotation | [N] | [N] | [+N] |

### Files Modified

| File | Items Documented |
|------|-----------------|
| [file] | [list of items] |

### Verification Gates
| Gate | Status |
|------|--------|
| Type Safety | PASS (no new errors introduced) |
| Pattern Scanner | PASS |
| Tests | PASS ([N] passed, unchanged) |

### Corrections Made (CR-9)
| File | Issue | Fix Applied |
|------|-------|------------|
| [file] | [incorrect doc] | [correction] |

### Next Steps
- Review changes: `git diff`
- Commit: `/massu-commit`
```
