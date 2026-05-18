#!/usr/bin/env bash
# CI-ONLY: workspace-shadow avoidance via scratch dir is CI-environment-specific;
# local devs run 'npx massu config check-drift' directly.
#
# Extracted from .github/workflows/massu-config-drift.yml `check-drift` job (P1-004,
# plan-2026-05-18-pre-push-ci-parity). Previous attempts with `npx --yes @massu/core@1`
# and `npx --yes --package=@massu/core@1 massu` both failed on ubuntu-latest with
# `sh: 1: massu: not found` (exit 127). Since this repo is itself a workspace that
# declares @massu/core, installing into the repo root would conflict with the local
# workspace copy — so we install into a scratch directory and invoke the bin directly.
# No npx path indirection; no workspace shadowing.

set -euo pipefail
IFS=$'\n\t'

SCRATCH=$(mktemp -d)
cleanup() { rm -rf -- "$SCRATCH"; }
trap cleanup EXIT INT TERM

pushd "$SCRATCH" >/dev/null
npm init -y >/dev/null
npm install --silent @massu/core@1
popd >/dev/null
"$SCRATCH/node_modules/.bin/massu" config check-drift
