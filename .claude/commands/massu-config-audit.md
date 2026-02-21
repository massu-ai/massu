---
name: massu-config-audit
description: Config validation - verify config-code alignment and config map fallback defaults
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---
name: massu-config-audit

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-9, CR-35 enforced.

# Massu Config Audit: Config-Code Alignment Validation

## Objective

Validate that configuration values align with code expectations, and that all config map patterns have proper fallback defaults:
1. **Config-code alignment**: Config values in `massu.config.yaml` MUST match what the code expects
2. **Fallback defaults**: Config map lookups MUST have fallback defaults for dynamic keys

**Philosophy**: A config that exists but has the wrong keys is worse than no config at all. It silently fails at runtime with a crash.

---

## NON-NEGOTIABLE RULES

- **Query actual values** - Never assume config keys match code expectations
- **Test dynamic lookups** - `CONFIG_MAP[dynamicKey]` crashes when key doesn't exist
- **Compare all environments** - Config values must be consistent where expected
- **FIX ALL ISSUES ENCOUNTERED (CR-9)** - If ANY config mismatch or missing fallback is discovered - whether from current changes OR pre-existing - fix it immediately. Search entire codebase for same config map pattern and fix ALL instances.

---

## Section 1: Config Schema Validation

### 1.1 Validate massu.config.yaml

```bash
# Parse and validate config file
node -e "
const yaml = require('yaml');
const fs = require('fs');
const config = yaml.parse(fs.readFileSync('massu.config.yaml', 'utf-8'));
console.log(JSON.stringify(Object.keys(config), null, 2));
console.log('Config valid');
"
```

### 1.2 Verify Config Keys Match Code Usage

```bash
# Find all getConfig() usages in code
grep -rn "getConfig()" packages/core/src/ --include="*.ts" | grep -v __tests__ | head -20

# Find all config property accesses
grep -rn "config\.\|getConfig()\." packages/core/src/ --include="*.ts" | grep -v __tests__ | head -30
```

### 1.3 Compare Config Schema to Code Expectations

For each config property accessed in code, verify it exists in the config file and has the expected type/value.

---

## Section 2: Fallback Default Audit

**CONFIG_MAP lookups with dynamic keys crash when the key doesn't exist. ALWAYS use fallbacks.**

### 2.1 Find Config Map Patterns Without Fallbacks

```bash
# Find CONFIG_MAP or similar map lookups with dynamic keys (potential crash sites)
grep -rn "CONFIG_MAP\[\|configMap\[\|DEFAULTS\[" packages/core/src/ --include="*.ts" | grep -v "//.*CONFIG_MAP" | grep -v __tests__
```

### 2.2 Verify Each Lookup Has a Fallback

For each match from 2.1, verify the pattern is safe:

```typescript
// WRONG - crashes when key doesn't exist
const config = CONFIG_MAP[status].label;

// CORRECT - uses fallback when key doesn't exist
const config = (CONFIG_MAP[status] || CONFIG_MAP.default || DEFAULT_CONFIG).label;
```

### 2.3 Fallback Audit Report

| File | Line | Pattern | Has Fallback? | Fix Required? |
|------|------|---------|---------------|---------------|
| Check required | - | - | - | - |

---

## Section 3: Tool Prefix Consistency

### 3.1 Verify Tool Prefix Usage

```bash
# Check that all tool names use config-driven prefix
grep -rn "toolPrefix\|getConfig()\.toolPrefix" packages/core/src/ --include="*.ts" | head -20

# Check for hardcoded tool prefixes (should use config)
grep -rn "'massu_\|\"massu_" packages/core/src/ --include="*.ts" | grep -v __tests__ | grep -v config | head -20
```

### 3.2 Verify Prefix Helper Usage

```bash
# Check that the p() prefix helper or equivalent is used consistently
grep -rn "stripPrefix\|p(" packages/core/src/ --include="*.ts" | head -20
```

---

## Section 4: Config File Completeness

### 4.1 Check Required Config Sections

```bash
# Verify all expected top-level config sections exist
grep -n "^[a-zA-Z]" massu.config.yaml | head -20
```

### 4.2 Check for Missing Config Entries

```bash
# Find config keys referenced in code but potentially missing from config
grep -rn "config\.\([a-zA-Z]*\)" packages/core/src/ --include="*.ts" | grep -v __tests__ | \
  sed 's/.*config\.\([a-zA-Z]*\).*/\1/' | sort -u
```

Compare extracted keys against actual config file sections.

---

## Section 5: Environment Variable Audit

### 5.1 Find Environment Variable References

```bash
# Find process.env references
grep -rn "process\.env\." packages/core/src/ --include="*.ts" | grep -v __tests__ | head -20
```

### 5.2 Verify Environment Variables Are Documented

For each environment variable found, verify it is documented in README or config.

---

## Section 6: Mismatch Report

### 6.1 Config-Code Mismatch Summary

```markdown
## Config-Code Alignment Report - [DATE]

### Critical Mismatches (Runtime Crash)
- [config_key]: Code expects value "[X]", config has value "[Y]"

### Missing Fallbacks (Violations)
- [file]:[line]: CONFIG_MAP[[dynamic_key]] has no fallback

### Missing Config Entries
- [key]: Referenced in code but not in massu.config.yaml

### Remediation Required
- [description of each fix needed]
```

---

## Completion Criteria

- [ ] massu.config.yaml parses without errors
- [ ] All config properties accessed in code exist in config file
- [ ] All config map lookups have fallback defaults
- [ ] Tool prefix is consistently config-driven (no hardcoded prefixes)
- [ ] All environment variables are documented
- [ ] 0 config map lookups without fallbacks
- [ ] All mismatches fixed or documented

**Remember: Config exists != data is correct. Always verify actual values before claiming config alignment.**
