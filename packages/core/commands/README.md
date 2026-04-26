# Massu Slash-Command Templates

This directory ships the slash commands installed into a consumer project's `<claudeDirName>/commands/` (default `.claude/commands/`) when the consumer runs `npx @massu/core install-commands` (or `npx @massu/core init`, which calls install-commands as part of its flow).

As of `@massu/core@1.3.0`, command files are **stack-aware**: a template can ship one or more language-specific variants alongside the default, and the installer picks the variant that matches the consumer's `massu.config.yaml`. Local edits are preserved across reinstalls via a manifest written to `<claudeDirName>/.massu/install-manifest.json`.

This README covers:

1. The variant filename convention.
2. The variant-resolution algorithm (priority order + tie-break).
3. The local-edit-protection manifest.
4. The `npx @massu/core show-template <name>` debugging command.

## 1. Variant filename convention

```
<base>.md                        # default — used when no variant matches
<base>.python.md                 # FastAPI / Django / generic Python (one-axis)
<base>.python-fastapi.md         # Python + FastAPI (two-axis: lang + sub-framework)
<base>.python-django.md          # Python + Django (two-axis: lang + sub-framework)
<base>.swift.md                  # SwiftUI / iOS / visionOS
<base>.rust.md                   # axum / actix / generic Rust
<base>.typescript.md             # reserved for future use; currently no variants ship
```

The two-axis form (`<base>.<lang>-<framework>.md`) is tried BEFORE the one-axis (`<base>.<lang>.md`) form. It is selected when the consumer's config declares `framework.languages.<lang>.framework = "<sub-framework>"` (e.g. `fastapi` or `django`).

The variant convention applies **only at the top level** of `packages/core/commands/`. Files inside subdirectories (e.g., `_shared-references/`, `massu-loop/references/`) are copied recursively as-is — no variant resolution, no dot-skip filtering. Future authors can use dotted filenames in nested dirs without losing them to the variant filter.

The variant convention is **opt-in**: a template that does NOT ship any `<base>.<variant>.md` siblings is variant-agnostic and the unsuffixed `<base>.md` is used everywhere.

## 2. Variant-resolution algorithm

Given a base template name `B` and the consumer's `framework` config from `massu.config.yaml`:

1. **Build the candidate list `V`** in priority order:
   1. `framework.primary` (or `framework.type` if `primary` is undefined). Skipped if the value is `"multi"`.
   2. Each declared `framework.languages.<lang>` entry whose `framework` field is a non-empty string, in **YAML declaration order** (first-declared wins on ties).
   3. **Passthrough fallback**: well-known top-level `framework.<lang>` blocks (typescript / javascript / python / swift / rust / go) with a non-empty `framework` field, in fixed order, excluding any language already covered. This is what lets a project that declares `framework.swift` at the top level (alongside `framework.languages.python`) still pick up the `.swift.md` variant when the languages block doesn't contain swift.
   4. The unsuffixed default (`""`) as the last fallback.
2. **Probe disk** in order: for each candidate `c`, check whether `<base>.<c>.md` exists in the bundled commands directory.
3. **Return**:
   - First hit → copy that file.
   - No hit AND `framework.type === "multi"` AND `framework.primary` is undefined → write a one-line warning to stderr and copy the unsuffixed default.
   - No hit otherwise → skip the file (this only happens if the base template was deleted and only orphan variants remain, which the Phase 0 audit prevents).

The target filename in the consumer dir is always the BASE name (`<base>.md`) — variant suffixes are an internal package detail.

### Tie-break — which variant wins?

If a consumer declares both `python` and `swift` in `framework.languages` AND a template ships both `.python.md` and `.swift.md`, the variant declared FIRST in `framework.languages` wins. Consumers control this by reordering keys in `massu.config.yaml`. Passthrough-fallback entries (rule 1.3) are appended AFTER all `framework.languages` entries.

There is no per-template override mechanism. If you need one, file an issue.

## 3. Local-edit protection — the manifest

`@massu/core@1.3.0` introduces a manifest at:

```
<consumer-root>/<claudeDirName>/.massu/install-manifest.json
```

(where `claudeDirName` is the value of `conventions.claudeDirName` in `massu.config.yaml`, defaulting to `.claude`).

Each entry maps an asset-relative path (e.g., `commands/massu-scaffold-router.md`) to the SHA-256 of its content at the last successful install.

### What the installer does on each run

For each file `<asset>` to be installed, three hashes are computed:

| Hash | What it represents |
|------|--------------------|
| `sourceHash` | The bundled upstream content NOW. |
| `existingHash` | The current consumer file content. `undefined` if missing. |
| `lastInstalledHash` | The hash recorded in the manifest. `undefined` on first install. |

Decision matrix:

| Condition | Action | Counter |
|-----------|--------|---------|
| target missing | write upstream, record `sourceHash` in manifest | `installed` |
| `existingHash === sourceHash` | already in sync; record `sourceHash` (covers manifest healing) | `skipped` |
| `lastInstalledHash` undefined AND `existingHash !== sourceHash` | first-install heuristic: keep the consumer file, record `existingHash`, print a one-line notice | `kept` |
| `existingHash !== lastInstalledHash` (consumer edited it) | preserve, print `kept your version` notice + diff hint | `kept` |
| `existingHash === lastInstalledHash` AND `sourceHash !== lastInstalledHash` (clean upstream upgrade) | write upstream, record `sourceHash` | `updated` |

The manifest is written **atomically** (`tempfile + renameSync`) so a crash mid-install never leaves a partially-written manifest.

### What this means for you

- Edit your `<claudeDirName>/commands/*.md` freely. The installer will not stomp your edits.
- To accept the upstream version of a file you've edited: delete it and rerun `install-commands`.
- To diff your version against upstream:
  ```bash
  diff .claude/commands/massu-scaffold-router.md \
       <(npx @massu/core show-template massu-scaffold-router)
  ```

## 4. `npx @massu/core show-template <name>`

Prints the resolved template content (post-variant-resolution) to stdout. Used in the diff one-liner above. Accepts both `massu-scaffold-router` and `massu-scaffold-router.md`. Exits 1 on unknown names.

## 5. Currently shipped variants

| Base | Variants |
|------|----------|
| `massu-scaffold-router` | `.python-fastapi.md` (FastAPI — two-axis), `.python-django.md` (Django — two-axis) |
| `massu-scaffold-page` | `.swift.md` (SwiftUI), regenerated default with embedded Next.js / FastAPI / SwiftUI / Rust examples |
| `massu-deploy` | `.python-launchd.md`, `.python-systemd.md`, `.python-docker.md`, `.python-fly.md` (all two-axis) |

All other top-level templates ship as variant-agnostic defaults (one `<base>.md`).

### Template variable substitution

As of `@massu/core@1.3.0`, template files may contain `{{variable.path}}` and `{{variable.path | default("fallback")}}` placeholders. These are rendered against the consumer's `massu.config.yaml` (all `framework.*`, `paths.*`, and `config.*` fields) plus the `detected.*` block written by the codebase introspector (e.g. `detected.python.auth_dep`, `detected.swift.api_client_class`).

Rules:
- Every `{{detected.*}}` reference MUST include a `| default("...")` fallback — introspection may return nothing.
- Use `\{{` to emit a literal `{{` in the rendered output (e.g. Go/Docker format strings).
- A render error on a single file causes that file to be skipped (stderr message only); the rest of the install continues.

Pass `--skip-commands` to `massu init` or `massu refresh` to suppress command installation entirely.

## 6. Adding a new variant

1. Create `<base>.<lang>.md` in this directory using the same frontmatter shape as the default.
2. The default `<base>.md` should remain generic (or be regenerated if it was previously stack-specific — see `massu-scaffold-page.md` for the pattern of an embedded multi-stack default).
3. Add a row to the table in section 5.
4. Add a test case to `packages/core/src/__tests__/install-commands.test.ts` that exercises the new variant against a fixture config.
5. Update `docs/internal/2026-04-26-template-variant-audit.md` (the audit doc) with the new label.

## 7. Reference

- Plan: `/Users/ekoultra/hedge/docs/plans/2026-04-26-massu-stack-aware-command-templates.md`
- Audit: `docs/internal/2026-04-26-template-variant-audit.md`
- Implementation: `packages/core/src/commands/install-commands.ts`
- Tests: `packages/core/src/__tests__/install-commands.test.ts` and `show-template.test.ts`
