# Social Media Reply Templates

Engagement-first reply templates for key accounts. **No links. No product mentions.** Build presence through genuine insight before any self-promotion.

**Escalation path:**
1. **Weeks 1-2:** Pure insight replies (below). Zero links.
2. **Weeks 3-4:** If someone asks "how did you build that?" — mention massu.ai in a reply to *them*, not to Boris/Karpathy.
3. **Week 5+:** Post your own thread. By then you're a recognized name.

**Timing:** Reply within 1-2 hours of their posts. 2-3 replies/week max across all accounts.

---

## Boris Cherny (@bcherny)

### 1. On CLAUDE.md Learning from Mistakes

> *Boris: "Anytime we see Claude do something incorrectly we add it to the CLAUDE.md, so Claude knows not to do it next time"*
> *([Thread 1, tweet 4](https://x.com/bcherny/status/2007179832300581177))*

**Reply:**

> We took this further — each mistake triggers a structured process: document what happened, why it was missed, then generate new rules AND automated checks simultaneously. After 22 incidents, the CLAUDE.md writes itself. The compounding effect is real — same bug literally can't slip through twice because the first occurrence created the defenses.

**Why this works:** Builds on his point, adds the incident loop system, gives a specific number (22), validates his approach while extending it.

---

### 2. On Verification as the #1 Tip

> *Boris: "Probably the most important thing to get great results out of Claude Code — give Claude a way to verify its work. If Claude has that feedback loop, it will 2-3x the quality"*
> *([Thread 1, tweet 13](https://x.com/bcherny/status/2007179832300581177))*

**Reply:**

> This is the insight that changed everything for me. We codified 46 verification types — file existence, code presence, build success, negative grep for removals, blast radius for value changes. The key shift was making verification *mandatory*, not optional. Claims without proof are worthless. Claude says "I added it to all 5 pages"? Show me the grep. "Build passes"? Show me exit code 0. Once you make verification a hard requirement instead of a suggestion, the quality jump is more like 5-10x.

**Why this works:** Validates his #1 tip with concrete evidence, adds specific examples, "claims without proof are worthless" is quotable.

---

### 3. On Plan Mode

> *Boris: "Start every complex task in plan mode. Pour your energy into the plan so Claude can 1-shot the implementation."*
> *([Thread 2, tweet 3](https://x.com/bcherny/status/2017742741636321619))*

**Reply:**

> The underrated part: the plan should include blast radius analysis *before* implementation. We had Claude change a constant that appeared in 30 places but only update 3. Now the rule is: grep the entire codebase for every old value being changed, categorize every occurrence, zero unknowns before writing code. Plans went from "list of tasks" to "proof that we understand the impact." Changed our defect rate dramatically.

**Why this works:** Practical extension with a war story. "30 places, only updated 3" is relatable — every Claude Code user has hit this.

---

### 4. On Claude Writing Its Own Rules

> *Boris: "After every correction, end with: Update your CLAUDE.md so you don't make that mistake again. Claude is eerily good at writing rules for itself."*
> *([Thread 2, tweet 4](https://x.com/bcherny/status/2017742741636321619))*

**Reply:**

> Claude writing rules for itself is the unlock. We went further: when a bug gets through, it triggers prevention at 5 layers simultaneously — new CLAUDE.md rule, new automated pre-commit check, new hook that fires in relevant contexts, persistent memory entry, and a pattern scanner gate. The CLAUDE.md alone is good. But the same bug *can't* happen when there are 5 independent defenses instead of 1.

**Why this works:** Direct extension. "5 layers" framework is concrete and memorable.

---

### 5. On Parallel Sessions

> *Boris: "I run 5 Claudes in parallel in my terminal"*
> *([Thread 1, tweet 2](https://x.com/bcherny/status/2007179832300581177))*

**Reply:**

> The parallel sessions approach works, but the thing nobody talks about is context isolation. Each session needs its own clean context or they drift — one session's decisions can contradict another's. We solved this with structured session state that persists critical decisions across all active sessions, plus hooks that detect when context is degrading in long sessions. The quality of session #4 shouldn't be worse than session #1.

**Why this works:** Identifies a real problem with his workflow (context drift) and offers a solution. Gets "great point" responses.

---

### 6. On 100% AI-Written Code

> *Boris: "In the last thirty days, 100% of my contributions to Claude Code were written by Claude Code"*
> *([x.com/bcherny/status/2004897269674639461](https://x.com/bcherny/status/2004897269674639461))*

**Reply:**

> The thing that makes 100% AI-written code possible is 100% AI-verified code. Without mandatory verification at every step — build passes, types check, tests green, pattern compliance — "AI-written" is just "AI-generated." The verification system is the unsexy part that makes the impressive number real.

**Why this works:** Reframes his achievement as enabled by verification. Short, punchy, quotable.

---

## Andrej Karpathy (@karpathy)

### 7. On "Agentic Engineering" Definition

> *Karpathy: "The goal is to claim the leverage from the use of agents but without any compromise on the quality of the software."*
> *([x.com/karpathy/status/2019137879310836075](https://x.com/karpathy/status/2019137879310836075))*

**Reply:**

> This is the sentence that separates 2025 from 2026. The leverage is obvious — everyone's felt it. The "without any compromise on quality" part is where 95% of teams are still failing. The agents make subtle conceptual errors (as you said — sloppy junior dev mistakes), and without automated enforcement at every gate — pre-edit, pre-commit, pre-push — those errors compound silently. The governance system around the agents matters more than the agents themselves.

**Why this works:** Quotes his words back, builds on his framework, introduces governance thesis without pitching. Closing line is a strong standalone idea.

---

### 8. On "Watch Them Like a Hawk"

> *Karpathy: Models make "subtle conceptual errors that a slightly sloppy, hasty junior dev might do." ... "watch them like a hawk"*
> *([x.com/karpathy/status/2015883857489522876](https://x.com/karpathy/status/2015883857489522876))*

**Reply:**

> "Watch them like a hawk" doesn't scale when you're running 5 agents in parallel. The answer is automating the hawk — hooks that fire at session start, file edit, pre-commit, context compression. 11 automated gates that catch violations before a human ever needs to review. The agents are tireless (as you said — they never get demoralized). The enforcement needs to be equally tireless.

**Why this works:** Identifies tension in his own advice, proposes specific solution, mirrors his observation about agent stamina. "Automating the hawk" is memorable.

---

### 9. On Declarative Over Imperative

> *Karpathy: "Don't tell it what to do, give it success criteria and watch it go"*
> *([x.com/karpathy/status/2015883857489522876](https://x.com/karpathy/status/2015883857489522876))*

**Reply:**

> This maps to something we found building governance systems: the rules that work are *verifiable* rules, not advisory rules. "Follow good practices" (imperative, advisory) fails. "Every file change requires grep proof of pattern compliance" (declarative, verifiable) succeeds. The shift from telling the agent *how* to work to defining *what success looks like* and letting it prove it — that's the real unlock for quality at scale.

**Why this works:** Takes his general principle, applies it to governance/rules. Intellectual extension, not a product pitch.

---

### 10. On the "Slopacolypse"

> *Karpathy: "I am bracing for 2026 as the year of the slopacolypse across all of github"*
> *([x.com/karpathy/status/2015883857489522876](https://x.com/karpathy/status/2015883857489522876))*

**Reply:**

> The slopacolypse is already here — the "almost right, but not quite" code that passes a casual glance but fails under real load. The antidote isn't slowing down. It's automated verification that catches the slop before it ships. Pattern scanning, blast radius analysis, negative grep for removals, mandatory proof for every claim. The teams that build enforcement into their AI workflow will ship fast AND clean. The ones that don't will contribute to the slopacolypse.

**Why this works:** Uses his coined term, agrees with prediction, positions governance as the solution. "Antidote isn't slowing down" avoids the friction criticism.

---

### 11. On Feeling Behind

> *Karpathy: "I've never felt this much behind as a programmer... I have a sense that I could be 10X more powerful if I just properly string together what has become available"*
> *([x.com/karpathy/status/2004607146781278521](https://x.com/karpathy/status/2004607146781278521))*

**Reply:**

> The "stringing together" is the hard part and nobody's talking about it. It's not just picking the right tools — it's building the system around them. Which rules does the agent follow? How do you prevent session 3 from contradicting session 1? What happens when the agent claims something's done but isn't? The 10X isn't in the model. It's in the orchestration layer that keeps the model honest.

**Why this works:** Addresses his expressed frustration, validates it, reframes solution as systems thinking. "10X isn't in the model" is a strong standalone line.

---

## Key Principles

- **Never say "I built a tool that does this"** in a reply to them
- **Never link to massu.ai** in a reply to them
- **Never use their posts as a springboard for self-promotion**
- If they engage, keep the conversation going with more insight, not a pitch
- The goal: be the person who consistently adds the most thoughtful takes to their threads
- The product sells itself once people know who you are

---

*Last updated: 2026-02-17*
