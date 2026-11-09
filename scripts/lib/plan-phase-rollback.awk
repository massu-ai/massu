# plan-phase-rollback.awk — does every phase a plan DECLARES carry a rollback?
#
# Read by scripts/massu-plan-status-validator.sh, one plan markdown file per
# invocation. Output is tab-separated, one record per line:
#
#   RBSEC   <line> <heading>              the plan's rollback section
#                                         (absent => the plan is OUT OF SCOPE)
#   PHASE   <id> <line> own|section|NO    one row per DECLARED phase
#   SUMMARY <phases> <uncovered>          always emitted (the denominator)
#
# WHY THIS EXISTS. docs/plans/2026-07-23-hook-latency-and-silent-loss-fixes.md
# shipped its rollback section enumerating P1-P5, then grew P6 (2026-08-07) and
# P7 (2026-08-11) — each landing in the implementation section while the
# rollback section, written once and hundreds of lines away, was never revisited.
# Both gaps were found by hand, months apart. A hand-maintained list that misses
# twice is a class, not an accident.
#
# COVERAGE IS SATISFIED TWO WAYS, and co-location is the better one:
#   own      a `**Rollback**:` line inside the phase's OWN block. Nothing can
#            drift, because the rollback is written where the phase is written.
#   section  the phase id named in the plan's rollback section (cross-reference).
#            This is the shape that drifted twice; it is accepted, not preferred.
#
# WHAT IS DELIBERATELY NOT MATCHED, each measured against the real corpus:
#   * "Phase Shippability" must not parse as phase "S" — hence the trailing
#     delimiter clause on the id.
#   * An ITEM id must not discharge its PHASE: `P4-003` in a rollback section is
#     an item reference, and crediting it would let a phase be "covered" by a
#     line that never mentions it (memory: an-assertion-can-be-satisfied-by-a-
#     different-line-than-the-one-it-names). Hence `P<id>` may not be followed
#     by `-<digit>`.
#   * A bare digit in prose ("revert 1 commit") must not discharge phase 1 —
#     hence the three anchored forms in named() below.
#   * Headings inside ``` fences are documentation of markdown, not declarations.

function norm(s) {
  gsub(/\342\200\223/, "-", s)   # en dash -> hyphen (octal: mawk has no \x)
  gsub(/\342\200\224/, "-", s)   # em dash -> hyphen
  return s
}

# A `.` in a phase id ("4.8") is a regex wildcard once the id is interpolated into
# a dynamic regex. Escape it, or "P4.8" matches "P4x8".
function rx(id,   e) { e = id; gsub(/\./, "\\.", e); return e }

# Does the rollback body NAME phase `id`? Every accepted form is EXPLICIT — the
# id carries a `P` prefix, the word "Phase", or (letters only) a label colon.
#   P<id>          unambiguous on its own      -> "P6: revert the spool write"
#   Phase[s] <id>  spelled out                 -> "Phase A is additive"
#   <A>:           a letter in label position  -> "A: revert restores matching"
# A bare NUMBER is never accepted: "revert 1 commit" must not discharge Phase 1,
# and a numbered list item ("1. Deprecate on npm") must not either.
function named(id, body,   e) {
  e = rx(id)
  if (id ~ /^[0-9]/) {
    # `[^0-9-]` — an ITEM id (P4-003) must not discharge PHASE 4.
    if (body ~ ("(^|[^0-9A-Za-z])P" e "([^0-9-]|$)")) return 1
  } else if (body ~ ("(^|[^0-9A-Za-z])" e "[ \t]*:")) {
    return 1
  }
  if (body ~ ("(^|[^0-9A-Za-z])[Pp]hases?[ \t]+P?" e "([^0-9]|$)")) return 1
  if (id in rangecov) return 1
  return 0
}

# Expand an inclusive range written in the rollback section: "P1-P5",
# "Phases 1 - 5", "A-D". Both dash forms are normalised to "-" by norm().
#
# BOTH ENDPOINTS MUST BE EXPLICIT — `P1-P5`, or a "Phase(s)" prefix on the pair.
# A bare `<a>-<b>` was the first draft and it read version strings and item ids as
# phase ranges ("1.1.0 - 1.2.0", "P5-007"), inventing coverage out of prose. Worse,
# it did so DIFFERENTLY under mawk and BWK awk — macOS invented ranges {5,6,7,103,
# 104} on one real plan and Linux invented {1,2,3,5,6,7,103,104}, so the gate's
# verdict depended on which awk ran it (measured 2026-08-12, Docker node:22 vs
# macOS). A gate whose answer is platform-dependent is not a gate.
function expand(body,   s, m, a, b, i) {
  s = body
  while (match(s, /([Pp]hases?[ \t]*)?P[0-9]+[ \t]*-[ \t]*P[0-9]+|[Pp]hases?[ \t]*[0-9]+[ \t]*-[ \t]*[0-9]+|([Pp]hases?[ \t]*)?P?[A-Z][ \t]*-[ \t]*P?[A-Z]/)) {
    m = substr(s, RSTART, RLENGTH)
    s = substr(s, RSTART + RLENGTH)
    a = m; sub(/[ \t]*-.*$/, "", a); sub(/^[Pp]hases?[ \t]*/, "", a); sub(/^P/, "", a)
    b = m; sub(/^.*-[ \t]*/, "", b); sub(/^[Pp]hases?[ \t]*/, "", b); sub(/^P/, "", b)
    if (a ~ /^[0-9]+$/ && b ~ /^[0-9]+$/) {
      if (a + 0 <= b + 0) { for (i = a + 0; i <= b + 0; i++) rangecov[i ""] = 1 }
    } else if (a ~ /^[A-Z]$/ && b ~ /^[A-Z]$/) {
      for (i = index(ALPHA, a); i <= index(ALPHA, b); i++) rangecov[substr(ALPHA, i, 1)] = 1
    }
  }
}

BEGIN {
  ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  fence = 0; rb_level = 0; in_rb = 0; rb_line = 0; rb_head = ""; rb_body = ""
  cur_phase = 0; cur_level = 0; n = 0
}

/^[ \t]*(```|~~~)/ { fence = 1 - fence; next }
fence == 1 { next }

/^#+[ \t]/ {
  lvl = 0
  while (substr($0, lvl + 1, 1) == "#") lvl++
  text = substr($0, lvl + 1); sub(/^[ \t]+/, "", text)

  if (in_rb == 1 && lvl <= rb_level) in_rb = 0
  if (cur_phase != 0 && lvl <= cur_level) cur_phase = 0

  probe = text
  sub(/^[0-9]+(\.[0-9]+)*[.)]?[ \t]+/, "", probe)   # strip "7." / "6.5" numbering

  if (probe ~ /^[Rr][Oo][Ll][Ll][Bb][Aa][Cc][Kk]([^A-Za-z]|$)/) {
    if (rb_line == 0) { rb_line = NR; rb_head = text }
    rb_level = lvl; in_rb = 1
    next
  }

  if (probe ~ /^[Pp][Hh][Aa][Ss][Ee][ \t]+(P?[0-9]+(\.[0-9]+)*|[A-Z])([^0-9A-Za-z.]|$)/) {
    id = probe
    sub(/^[Pp][Hh][Aa][Ss][Ee][ \t]+P?/, "", id)
    sub(/[^0-9A-Z.].*$/, "", id)
    sub(/\.$/, "", id)
    if (!(id in pidx)) {
      n++; pid[n] = id; pline[n] = NR; pown[n] = 0; pidx[id] = n
    }
    cur_phase = pidx[id]; cur_level = lvl
  }
  next
}

in_rb == 1 { rb_body = rb_body " " norm($0); next }

cur_phase != 0 {
  if ($0 ~ /\*\*[Rr]ollback\*\*/ || $0 ~ /(^|[^A-Za-z])[Rr]ollback[ \t]*:/) pown[cur_phase] = 1
  next
}

END {
  if (rb_line > 0) print "RBSEC\t" rb_line "\t" rb_head
  expand(rb_body)
  bad = 0
  for (i = 1; i <= n; i++) {
    if (pown[i] == 1) how = "own"
    else if (named(pid[i], rb_body) == 1) how = "section"
    else { how = "NO"; bad++ }
    print "PHASE\t" pid[i] "\t" pline[i] "\t" how
  }
  print "SUMMARY\t" n "\t" bad
}
