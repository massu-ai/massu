#!/usr/bin/env bash
#
# run-logged.sh — run a command with its output AND its authoritative exit code
# captured in ONE log file, so a gate can never look GREEN while it is RED.
#
# Usage:
#   scripts/run-logged.sh <logfile> -- <command...>
#
# Example:
#   scripts/run-logged.sh /tmp/prepush.log -- bash scripts/pre-push-light.sh
#   echo "helper exit: $?"          # <-- this IS the command's real exit (see below)
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THIS EXISTS — the two defects it makes structurally impossible
# (see the 2026-07-14 masked-exit / grepped-wrong-file postmortem in the internal
#  incident records)
#
#   1. MASKED EXIT ("success is not a receipt", CR-67). A gate run as
#          bash scripts/pre-push-light.sh > some.log 2>&1
#          echo "DONE: $?"
#      reports the COMPOUND's exit = the LAST command's exit = the echo's 0,
#      while the gate's REAL exit (1) survives only as text in a log LINE.
#      A caller / background-notification that reads the PROCESS exit sees 0
#      and calls a RED gate GREEN.
#
#   2. GREPPING THE WRONG FILE (the BLIND-GATE law). The gate's real output
#      went to `some.log`, but the reader greps a DIFFERENT file (a wrapper /
#      background-task output file that holds only the echo line), finds
#      "0 PASS, 0 FAIL", and reports a false "clean." "Could not look" and
#      "looked and found nothing" produce the SAME value — and it is the
#      PASSING one.
#
# ─────────────────────────────────────────────────────────────────────────────
# THE ONE-FILE RULE — read this and obey it:
#
#   * The command's live output AND its authoritative exit code live in the
#     SAME <logfile>. ALWAYS read THAT file — never a wrapper, task-output,
#     or notification file.
#
#   * The ONLY trustworthy pass/fail signal is the final sentinel line of the
#     log, written by THIS script:
#             __RUN_EXIT__=<code>
#     `<code> == 0` means the command PASSED; anything else means it FAILED.
#     NEVER trust a trailing `echo`, a background-task's reported exit, or the
#     exit of a `tee`/pipeline as the gate's result.
#
#   * This script ALSO exits with the command's real code, so a caller that
#     checks the process exit gets the truth too — there is no trailing
#     command to mask it.
#
set -uo pipefail

if [[ $# -lt 3 || "${2:-}" != "--" ]]; then
  echo "run-logged.sh: ERROR — usage: run-logged.sh <logfile> -- <command...>" >&2
  echo "run-logged.sh: refusing to run silently; got args: $*" >&2
  exit 2
fi

LOGFILE="$1"
shift 2   # drop <logfile> and the literal --

if [[ -z "${LOGFILE}" ]]; then
  echo "run-logged.sh: ERROR — empty <logfile> argument" >&2
  exit 2
fi
if [[ $# -lt 1 ]]; then
  echo "run-logged.sh: ERROR — no command given after --" >&2
  exit 2
fi

# Run the command, tee'ing stdout+stderr to the log (operator sees it live AND
# it is captured). Capture the COMMAND's exit via PIPESTATUS[0], NOT tee's exit.
"$@" 2>&1 | tee "${LOGFILE}"
run_exit=${PIPESTATUS[0]}

# Append the authoritative sentinel as the FINAL line of the SAME log.
printf '__RUN_EXIT__=%s\n' "${run_exit}" >> "${LOGFILE}"

# Exit with the command's real code — no trailing command can mask it.
exit "${run_exit}"
