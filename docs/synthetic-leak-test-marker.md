# Synthetic Leak Test — 2026-05-09

This file is part of master plan row 4.9 — verify the public-repo leak guard
catches a known content-trigger before merge.

The leak guard's content scanner (`scripts/massu-public-leak-guard.sh`) trips on
the substring `hedge` (the user's private trading project name). This file
contains that marker intentionally so the leak guard MUST flag it.

If you see this file on `main`, the leak guard failed and there is a bug.

Expected behavior:
1. Push to feature branch — leak-guard CI fires.
2. Open PR — leak-guard status check fails.
3. Merge to main — BLOCKED by required status check.

Hedge.
