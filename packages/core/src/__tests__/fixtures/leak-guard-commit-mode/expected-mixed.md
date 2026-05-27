# Mixed Fixture — Tokenizer Regression Case

This fixture starts with several paragraphs of clean prose (no triggers).

Generic prose: feature flags, gradual rollouts, observability dashboards, error budgets, structured logging, immutable infrastructure, declarative configuration, idempotent operations, eventually-consistent state machines, deterministic builds.

The trigger word appears in the middle of the file, surrounded by prose that does NOT match the leak pattern, to ensure the scanner doesn't short-circuit on the first non-matching paragraph: the word CONFIDENTIAL is present here as a regression test.

After the trigger, more clean prose follows: continuous integration, blue-green deployment, canary releases, chaos engineering, distributed tracing, observability-driven development.

The scanner MUST detect the embedded trigger regardless of surrounding context.
