#!/usr/bin/env node
import{createRequire as __cr}from"module";const require=__cr(import.meta.url);

// src/hooks/intent-suggester.ts
var COMMAND_MAPPINGS = [
  {
    keywords: ["test", "failing"],
    command: "/massu-test",
    description: "Run and analyze tests"
  },
  {
    keywords: ["debug", "bug"],
    command: "/massu-debug",
    description: "Debug an issue"
  },
  {
    keywords: ["refactor"],
    command: "/massu-refactor",
    description: "Guided refactoring workflow"
  },
  {
    keywords: ["security", "vulnerability"],
    command: "/massu-security-scan",
    description: "Run a security scan"
  },
  {
    keywords: ["benchmark", "performance", "slow"],
    command: "/massu-benchmark",
    description: "Run performance benchmarks"
  },
  {
    keywords: ["cleanup", "dead code", "unused"],
    command: "/massu-cleanup",
    description: "Clean up dead code and unused exports"
  },
  {
    keywords: ["document", "jsdoc", "readme"],
    command: "/massu-doc-gen",
    description: "Generate documentation"
  },
  {
    keywords: ["estimate", "effort", "how long"],
    command: "/massu-estimate",
    description: "Estimate implementation effort"
  },
  {
    keywords: ["accessibility", "a11y", "wcag"],
    command: "/massu-accessibility",
    description: "Run accessibility checks"
  },
  {
    keywords: ["retrospective", "retro", "learnings"],
    command: "/massu-retrospective",
    description: "Run a session retrospective"
  },
  {
    keywords: ["onboard", "new member"],
    command: "/massu-onboard",
    description: "Onboard a new team member"
  },
  {
    keywords: ["release", "deploy"],
    command: "/massu-release",
    description: "Prepare a release"
  },
  {
    keywords: ["commit"],
    command: "/massu-commit",
    description: "Pre-commit verification gate"
  },
  {
    keywords: ["push"],
    command: "/massu-push",
    description: "Pre-push full verification gate"
  },
  {
    keywords: ["plan"],
    command: "/massu-create-plan",
    description: "Create an implementation plan"
  }
];
function findMatchingCommand(prompt) {
  const lowerPrompt = prompt.toLowerCase();
  for (const mapping of COMMAND_MAPPINGS) {
    for (const keyword of mapping.keywords) {
      if (lowerPrompt.includes(keyword.toLowerCase())) {
        return mapping;
      }
    }
  }
  return null;
}
async function main() {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input);
    const { prompt } = hookInput;
    if (!prompt || !prompt.trim()) {
      process.exit(0);
      return;
    }
    const match = findMatchingCommand(prompt);
    if (!match) {
      process.exit(0);
      return;
    }
    process.stdout.write(
      `Tip: Use ${match.command} to ${match.description}.`
    );
  } catch (_e) {
  }
  process.exit(0);
}
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 3e3);
  });
}
main();
