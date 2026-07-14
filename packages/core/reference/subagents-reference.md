# Subagent Reference

> **Verification laws apply.** Read `.claude/commands/_verification-laws.md` — CR-64 (a gate must prove it can fail), CR-65 (broken and empty may never render identically), and: an audit that does not run commands is not an audit.

**Subagents**: Use the Task tool for spawning agents. **One task per agent** (Principle #20). Use for exploration to keep main context clean.

| Agent | Focus | Trigger |
|-------|-------|---------|
| security-reviewer | Vulns, auth, validation | massu-loop 1.5 |
| architecture-reviewer | Patterns, coupling, scale | massu-loop 1.5 |
| ux-reviewer | UX, a11y, states | massu-loop 1.5 |
| plan-auditor | Coverage, gaps, VR-* | massu-loop 2, checkpoint |
| blast-radius-analyzer | Impact of value changes | massu-create-plan |
| pattern-reviewer | Pattern compliance | massu-commit |
| schema-sync-verifier | Multi-env schema match | After migrations |
| migration-writer | SQL generation | massu-migrate |
| output-scorer | Quality scoring | Ad-hoc |
| help-sync | Docs vs code parity | massu-docs |
| competitive-scorer | Compare competing implementations | golden-path --competitive |
