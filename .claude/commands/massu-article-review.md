---
name: massu-article-review
description: "When user shares a URL, article, tweet, or post and wants analysis of how it applies to the project -- 'review this', 'what do you think of this'"
allowed-tools: WebFetch(*), WebSearch(*), Read(*), Write(*), Bash(*)
disable-model-invocation: true
---
name: massu-article-review

> **Shared rules apply.** Read `.claude/commands/_shared-preamble.md` before proceeding. CR-14, CR-5, CR-12 enforced.

# Massu Article Review: Technical Article Analysis Protocol

## Objective

Analyze technical articles, blog posts, and documentation to extract actionable insights for project development. Produce structured summaries with cost/benefit scoring and automatic comparison to current project approaches.

---

## ARGUMENTS

The command accepts an optional URL argument:

```
/massu-article-review https://example.com/article
/massu-article-review                              # Will prompt for input
```

**Arguments from $ARGUMENTS**: {{ARGUMENTS}}

---

## INPUT HANDLING

### Priority Order
1. If `$ARGUMENTS` contains a URL -> fetch it
2. If user pasted article content -> use that
3. Otherwise -> ask user for URL or content

### Paywall/Login Handling

**Claude Code CANNOT access authenticated sessions or bypass paywalls.**

If WebFetch fails or returns incomplete content:

```
The article appears to be behind a paywall or requires login.

Please provide the content using one of these methods:
1. Copy/paste the article text directly
2. Save as PDF from Safari and tell me the file path
3. Use Safari Reader mode -> Export -> provide file path
4. Save webpage as HTML and provide file path
```

---

## AUTOMATIC BEHAVIORS

### 1. Always Compare to Current Project Approach
Every review MUST include comparison to existing project patterns, commands, and architecture. This is NOT optional.

### 2. Always Save Review
Every review MUST be saved to the project's documentation directory.

### 3. Always Include Cost/Benefit Score
Every review MUST include a numeric score (see scoring section).

---

## COST/BENEFIT SCORING

Calculate a **Project Fit Score** (0-100):

### Scoring Components

| Component | Weight | Criteria |
|-----------|--------|----------|
| **Problem Relevance** | 25 pts | Does it solve a current project pain point? |
| **Architecture Fit** | 20 pts | Compatible with the project's technology stack? |
| **Pattern Compliance** | 20 pts | Can it follow project verification/quality patterns? |
| **Implementation Effort** | 15 pts | Low effort = high score, high effort = low score |
| **Risk Level** | 10 pts | Low risk = high score, high risk = low score |
| **Maintenance Burden** | 10 pts | Low maintenance = high score |

### Score Interpretation

| Score | Rating | Recommendation |
|-------|--------|----------------|
| 80-100 | Excellent | ADOPT - implement soon |
| 60-79 | Good | TRIAL - experiment in isolated context |
| 40-59 | Mixed | ASSESS - needs more research |
| 20-39 | Poor | HOLD - not suitable now |
| 0-19 | Bad | AVOID - conflicts with project patterns |

### Score Card Format

```markdown
## Project Fit Score: XX/100

| Component | Score | Notes |
|-----------|-------|-------|
| Problem Relevance | /25 | [why] |
| Architecture Fit | /20 | [why] |
| Pattern Compliance | /20 | [why] |
| Implementation Effort | /15 | [why] |
| Risk Level | /10 | [why] |
| Maintenance Burden | /10 | [why] |
| **TOTAL** | **XX/100** | **[RATING]** |
```

---

## ANALYSIS FRAMEWORK

### 1. Executive Summary
2-3 sentence overview of the article's main thesis.

### 2. Key Points Extraction

| # | Key Point | Technical Detail |
|---|-----------|------------------|
| 1 | [Point] | [Specifics] |
| 2 | [Point] | [Specifics] |

### 3. Technology/Tool Overview (if applicable)

| Aspect | Details |
|--------|---------|
| **Name** | [Tool/Tech name] |
| **Purpose** | [What it does] |
| **Key Features** | [Main features] |
| **Prerequisites** | [Requirements] |
| **Maturity** | [Production-ready/Beta/Experimental] |
| **Community** | [Downloads, stars, activity] |

### 4. Current Project Approach Comparison (MANDATORY)

**This section is REQUIRED for every review.**

| Aspect | Article Approach | Current Project Approach | Delta |
|--------|------------------|-------------------------|-------|
| [Feature 1] | [How article does it] | [How project does it] | [Difference] |
| [Feature 2] | [How article does it] | [How project does it] | [Difference] |

### Commands/Patterns That Overlap

| Project Asset | Overlap | Notes |
|---------------|---------|-------|
| `/massu-*` command | [Which one] | [How it compares] |
| Pattern file | [Which one] | [How it compares] |
| Existing tool | [Which one] | [How it compares] |

### What Project Does Better
- [Point 1]
- [Point 2]

### What Article Approach Does Better
- [Point 1]
- [Point 2]

### 5. Implementation Path (if score >= 40)

#### Phase 1: Assessment
- [ ] [Action items]

#### Phase 2: Trial (if applicable)
- [ ] [Action items]

#### Phase 3: Adoption (if applicable)
- [ ] [Action items]

---

## SOURCE CREDIBILITY

| Factor | Assessment |
|--------|------------|
| **Author** | [Expert/Practitioner/Unknown] |
| **Publication** | [Official/Major blog/Personal/Unknown] |
| **Date** | [Recent/Dated] |
| **Evidence** | [Metrics provided/Claims only] |
| **Community** | [Downloads/Stars/Activity] |

---

## REPORT FORMAT

The final report saved to file:

```markdown
# Article Review: [Title]

**Source**: [URL]
**Author**: [Name]
**Reviewed**: [Date]
**Reviewer**: Claude (massu-article-review)

---

## Project Fit Score: XX/100 - [RATING]

| Component | Score | Notes |
|-----------|-------|-------|
| Problem Relevance | /25 | |
| Architecture Fit | /20 | |
| Pattern Compliance | /20 | |
| Implementation Effort | /15 | |
| Risk Level | /10 | |
| Maintenance Burden | /10 | |
| **TOTAL** | **XX/100** | |

**Recommendation**: ADOPT / TRIAL / ASSESS / HOLD / AVOID

---

## Executive Summary

[2-3 sentences]

---

## Key Points

1. [Point]
2. [Point]
...

---

## Comparison to Current Project Approach

### What This Article Proposes
[Summary]

### How Project Currently Handles This
[Summary]

### Gap Analysis
| Gap | Impact | Action |
|-----|--------|--------|
| [Gap] | [Impact] | [Action] |

### Verdict
[Which approach is better and why]

---

## Benefits
- [Benefit 1]
- [Benefit 2]

## Concerns/Risks
- [Concern 1]
- [Concern 2]

---

## Implementation Path

[If score >= 40, provide phased approach]

---

## Action Items

- [ ] [Item 1]
- [ ] [Item 2]

---

## Related Resources
- [Link 1]
- [Link 2]

---

*Generated by /massu-article-review on [date]*
```

---

## EXECUTION STEPS

1. **Parse input**
   - Check $ARGUMENTS for URL
   - Check user message for pasted content
   - If neither, prompt user

2. **Fetch content**
   - If URL provided, use WebFetch
   - If WebFetch fails (paywall), prompt for alternative input
   - If content pasted, proceed

3. **Analyze article**
   - Apply full analysis framework
   - Calculate Project Fit Score
   - Compare to current project approach (MANDATORY)

4. **Generate report**
   - Use report format above
   - Include all required sections

5. **Save report**
   - Create filename: `YYYY-MM-DD-[slug].md`
   - Save to project documentation directory
   - Verify file was created

6. **Present summary**
   - Show score and recommendation in response
   - Confirm file saved with path

---

## QUALITY SCORING (silent, automatic)

After completing the review, self-score against these checks and append one JSONL line to `.claude/metrics/command-scores.jsonl`:

| Check | Pass condition |
|-------|---------------|
| `has_project_comparison` | Review includes "Comparison to Current Project Approach" section with non-empty content |
| `has_score_table` | Review includes Project Fit Score table with all 6 components scored |
| `saved_to_file` | Review file was successfully written |
| `has_action_items` | Review includes at least 2 concrete action items |

**Format** (append one line -- do NOT overwrite the file):
```json
{"command":"massu-article-review","timestamp":"ISO8601","scores":{"has_project_comparison":true,"has_score_table":true,"saved_to_file":true,"has_action_items":true},"pass_rate":"4/4","input_summary":"[slug]"}
```

This scoring is silent -- do NOT mention it to the user. Just append the line after saving the review.

---

## START NOW

1. Check for URL in arguments: `{{ARGUMENTS}}`
2. Check for pasted content in user message
3. Fetch or prompt as needed
4. Run full analysis with project comparison
5. Calculate and display Project Fit Score
6. Save review file
7. Confirm completion with file path
8. **Score and append to command-scores.jsonl** (silent)
