// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * VR Command Map (P1-005)
 * =======================
 *
 * Given a language + framework info + workspace directory, produce the
 * verification command set (VR-TEST, VR-TYPE, VR-BUILD, VR-SYNTAX, VR-LINT)
 * that the skill runners should invoke.
 *
 * User overrides from `massu.config.yaml` `verification.<language>.*` take
 * precedence over the built-in mapping.
 *
 * Usage:
 * ```ts
 * import { getVRCommands } from './detect/vr-command-map.ts';
 * const cmds = getVRCommands('python', { test_framework: 'pytest', ... }, 'apps/ai-service');
 * // => { test: 'cd apps/ai-service && python3 -m pytest -q', ... }
 * ```
 */

import type { SupportedLanguage } from './package-detector.ts';
import type { FrameworkInfo } from './framework-detector.ts';

export interface VRCommandSet {
  /** VR-TEST command. */
  test: string | null;
  /** VR-TYPE command. */
  type: string | null;
  /** VR-BUILD command. */
  build: string | null;
  /** VR-SYNTAX command. */
  syntax: string | null;
  /** VR-LINT command. */
  lint: string | null;
}

/** Shape read from `config.verification[<language>]`. */
export interface UserVerificationEntry {
  type?: string;
  test?: string;
  syntax?: string;
  lint?: string;
  build?: string;
}

function prefix(dir: string, cmd: string): string {
  if (!dir || dir === '.') return cmd;
  return `cd ${dir} && ${cmd}`;
}

function defaultsFor(
  language: SupportedLanguage,
  fw: FrameworkInfo,
  dir: string
): VRCommandSet {
  switch (language) {
    case 'python': {
      const testFw = fw.test_framework ?? 'pytest';
      return {
        test:
          testFw === 'unittest'
            ? prefix(dir, 'python3 -m unittest')
            : prefix(dir, 'python3 -m pytest -q'),
        type: prefix(dir, 'python3 -m mypy .'),
        build: null,
        syntax: prefix(dir, 'python3 -m py_compile'),
        lint: prefix(dir, 'python3 -m ruff check .'),
      };
    }
    case 'typescript': {
      const testFw = fw.test_framework ?? 'vitest';
      // Test command uses npm test (respecting package.json script); fallback mapping
      // is fine because npm test routes through whatever runner is wired.
      return {
        test: prefix(dir, 'npm test'),
        type: prefix(dir, 'npx tsc --noEmit'),
        build: prefix(dir, 'npm run build'),
        syntax: null,
        lint: prefix(dir, 'npx eslint .'),
        // testFw currently only affects defaults; npm test is runner-agnostic
        ...(testFw === 'mocha'
          ? { test: prefix(dir, 'npx mocha') }
          : {}),
      };
    }
    case 'javascript': {
      return {
        test: prefix(dir, 'npm test'),
        type: null,
        build: prefix(dir, 'npm run build'),
        syntax: null,
        lint: prefix(dir, 'npx eslint .'),
      };
    }
    case 'rust': {
      return {
        test: prefix(dir, 'cargo test'),
        type: prefix(dir, 'cargo check'),
        build: prefix(dir, 'cargo build'),
        syntax: null,
        lint: prefix(dir, 'cargo clippy -- -D warnings'),
      };
    }
    case 'swift': {
      return {
        test: prefix(dir, 'swift test'),
        type: prefix(dir, 'swift build'),
        build: prefix(dir, 'xcodebuild build'),
        syntax: null,
        lint: prefix(dir, 'swiftlint'),
      };
    }
    case 'go': {
      return {
        test: prefix(dir, 'go test ./...'),
        type: prefix(dir, 'go vet ./...'),
        build: prefix(dir, 'go build ./...'),
        syntax: null,
        lint: prefix(dir, 'golangci-lint run'),
      };
    }
    case 'java': {
      return {
        test: prefix(dir, 'mvn test'),
        type: prefix(dir, 'mvn compile'),
        build: prefix(dir, 'mvn package'),
        syntax: null,
        lint: null,
      };
    }
    case 'ruby': {
      return {
        test: prefix(dir, 'bundle exec rspec'),
        type: null,
        build: null,
        syntax: prefix(dir, 'ruby -c'),
        lint: prefix(dir, 'bundle exec rubocop'),
      };
    }
    default:
      return { test: null, type: null, build: null, syntax: null, lint: null };
  }
}

/**
 * Produce the VR command set for a language.
 *
 * User-provided entries (if any) override built-ins key-by-key.
 */
export function getVRCommands(
  language: SupportedLanguage,
  framework: FrameworkInfo,
  dir: string,
  userOverrides?: UserVerificationEntry
): VRCommandSet {
  const built = defaultsFor(language, framework, dir);
  if (!userOverrides) return built;
  return {
    test: userOverrides.test ?? built.test,
    type: userOverrides.type ?? built.type,
    build: userOverrides.build ?? built.build,
    syntax: userOverrides.syntax ?? built.syntax,
    lint: userOverrides.lint ?? built.lint,
  };
}
