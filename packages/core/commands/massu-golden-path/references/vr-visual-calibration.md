# VR-VISUAL Calibration Examples

> Reference doc for VR-VISUAL 4-dimension weighted scoring.
> Used by `scripts/ui-review.sh` and golden-path Phase 2.5 gap analysis.

## Purpose

Few-shot calibration examples that anchor the LLM evaluator's scoring, reducing drift across runs. The article's author found that calibrating the evaluator with detailed score breakdowns ensured judgment aligned with preferences.

---

## Scoring Dimensions (Recap)

| Dimension | Weight | What It Measures |
|-----------|--------|------------------|
| Design Quality | 2x | Coherent visual identity, deliberate choices |
| Functionality | 2x | Usable, clear hierarchy, findable actions |
| Craft | 1x | Spacing, typography, color consistency |
| Completeness | 1x | All states handled, no broken elements |

**Weighted Score** = (DQ×2 + FN×2 + CR×1 + CO×1) / 6
**PASS threshold**: >= 3.0/5.0

---

## Score 5: Excellent

**Description**: A page that a senior designer would approve without changes. Distinct visual identity, not generic template output.

**Design Quality (5)**: Colors, typography, and spacing work together to create a cohesive mood. The page has personality — you could tell it's this product without seeing the logo. No purple gradients over white cards. No generic SaaS dashboard look.

**Functionality (5)**: Primary action is immediately obvious. Navigation is intuitive. Information hierarchy is clear — the most important data is most prominent. Secondary actions are accessible but don't compete with primary.

**Craft (5)**: Consistent spacing throughout. Typography has clear hierarchy (headings, body, captions). Color palette is harmonious with adequate contrast ratios. No misaligned elements, no inconsistent border radii, no orphaned text.

**Completeness (5)**: Loading states use appropriate skeletons (not spinners for tabular data). Empty states have helpful messaging and a call-to-action. Error states are specific and actionable. No broken images, no placeholder text, no "TODO" comments visible.

---

## Score 3: Acceptable

**Description**: Functional and usable but unremarkable. Would not embarrass the team but wouldn't impress either. Typical of competent but uninspired output.

**Design Quality (3)**: Uses the design system correctly but without distinction. Colors are from the palette but the combination doesn't create a strong identity. Layout works but doesn't guide the eye naturally. It's "fine."

**Functionality (3)**: Primary actions are findable but may require a moment of scanning. Information is present but hierarchy could be clearer. Navigation works but some paths feel one extra click too deep.

**Craft (3)**: Mostly consistent spacing with occasional irregularities. Typography hierarchy exists but some levels are too similar in weight/size. Colors pass contrast checks but some combinations feel muddy.

**Completeness (3)**: Most states handled. May be missing one of: loading skeleton for a secondary section, empty state for an uncommon scenario, or error messaging for a specific failure mode. Nothing broken, but gaps exist in edge cases.

---

## Score 1: Failing

**Description**: Visually broken or fundamentally confusing. Would be flagged in any review.

**Design Quality (1)**: Generic AI-generated appearance — default component library styling, no visual identity. Or worse: clashing colors, inconsistent themes, elements that look like they belong to different products.

**Functionality (1)**: Primary action unclear. User has to guess what to do. Important data is buried or missing. Navigation is confusing — back button doesn't go where expected, breadcrumbs are wrong.

**Craft (1)**: Overlapping elements. Cut-off text. Inconsistent spacing (some sections have gaps, others are cramped). Typography has no clear hierarchy. Colors clash or have poor contrast (text invisible on background).

**Completeness (1)**: Obvious missing states — raw error objects displayed, blank sections where data should be, spinner that never resolves, "undefined" or "null" visible in the UI. Broken images showing alt text or image-not-found icons.

---

## Calibration Notes

- **Design quality and functionality are weighted 2x** because Claude already scores well on craft and completeness by default. The emphasis pushes toward more distinctive, user-centric output.
- **"Museum quality"** language in criteria pushes toward convergent aesthetics (the article noted this effect). Massu's criteria use more practical language ("distinct visual identity", "deliberate design choices") to encourage diversity.
- **Score 3.0 is the minimum bar, not the target.** Golden path should aim for 3.5+ on weighted score. Pages scoring 3.0-3.2 pass but should be flagged for improvement in post-build reflection.
- **Scores are route-specific.** An admin settings page scoring 3.5 is fine; a customer-facing landing page scoring 3.5 should be improved.
