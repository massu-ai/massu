name: massu-full-audit

# Massu Full Audit

Run the full 5-layer verification audit across the entire application.

## Layers

| Layer | Script | What It Checks |
|-------|--------|----------------|
| 1 | `codebase-audit-full.sh` | 19-phase static analysis (schema drift, security, patterns, coupling, ESLint, TypeScript, dead code) |
| 2 | `audit-feature-flags.sh` | Feature flag DB vs code reconciliation (dead flags, phantom flags, disabled-but-checked) |
| 3 | `validate-features.sh` | Sentinel feature registry integrity (orphaned features, missing components) |
| 4 | `audit-integration-health.sh` | OAuth tokens, integration status, webhook health, cron config, event backlogs |
| 5 | `check-coupling.sh` + `check-unwired-services.sh` + `check-page-reachability.sh` | Backend-frontend wiring, service connectivity, page navigation reachability |

## Usage

Run the orchestrator script:

```bash
# Full audit (all 5 layers)
./scripts/full-audit.sh

# Quick mode (skip Layer 1 static analysis, ~2min)
./scripts/full-audit.sh --quick

# Static analysis only (Layer 1)
./scripts/full-audit.sh --static-only

# Generate markdown report
./scripts/full-audit.sh --report
```

## Instructions

1. Run `./scripts/full-audit.sh --quick` first for a fast check
2. Review the summary output — each layer shows PASS/FAIL/WARN/SKIP
3. For any FAIL layers, check the detailed log at `/tmp/full-audit-layer-N.log`
4. Fix issues found, then re-run the failing layer individually
5. For a full audit including static analysis, run without flags (takes ~10min)
6. Use `--report` to save a markdown report to the project docs directory

## Exit Codes

- `0` — All layers pass
- `N` — Number of layers with failures

## Individual Layer Scripts

Each layer can be run independently:

```bash
./scripts/codebase-audit-full.sh          # Layer 1
./scripts/audit-feature-flags.sh          # Layer 2
./scripts/validate-features.sh            # Layer 3
./scripts/audit-integration-health.sh     # Layer 4
./scripts/check-coupling.sh              # Layer 5a
./scripts/check-unwired-services.sh      # Layer 5b
./scripts/check-page-reachability.sh     # Layer 5c
```
