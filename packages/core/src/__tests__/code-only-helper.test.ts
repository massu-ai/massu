// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Fixtures for the ONE shared comment stripper (`helpers/code-only.ts`).
 *
 * One fixture per case in P2.2 of
 * `docs/plans/2026-08-13-source-text-assertions-must-read-code-not-comments.md`, including
 * the three cases that are deliberately OUTSIDE cross-language byte-parity (block comments,
 * the `#!` shebang, and a trailing `//` after a quoted `://`) — each carries its ONE-SIDED
 * fixture here, so an exclusion from parity is never an untested behaviour.
 *
 * Every case is written against a behaviour some existing stripper got WRONG:
 *   trailing `//`      #2 #3 #5 #6 do not strip it at all
 *   `://` in a URL     #7 #8 truncate it
 *   `#`                NOT ONE of the eight handles it, and 10 of the 12 latent
 *                      assertions guard SHELL files
 *   string literals    #4 blanks them and the other seven do not — hence opt-in
 */
import { describe, it, expect } from 'vitest';
import { codeOnly, hasCommentSyntax, LINE_COMMENT } from './helpers/code-only.ts';

describe('codeOnly — the shared source-text comment stripper', () => {
  describe('full-line comments (the line is REMOVED, not blanked)', () => {
    it('drops a full-line `//` comment and its newline', () => {
      expect(codeOnly('const a = 1;\n// gone\nconst b = 2;\n', '.ts')).toBe(
        'const a = 1;\nconst b = 2;',
      );
    });

    it('drops an INDENTED full-line `//` comment', () => {
      expect(codeOnly('  if (x) {\n    // gone\n  }\n', '.ts')).toBe('  if (x) {\n  }');
    });

    it('drops a full-line `#` comment in shell — the marker no existing stripper handled', () => {
      expect(codeOnly('A=1\n# gone\nB=2\n', '.sh')).toBe('A=1\nB=2');
    });
  });

  describe('trailing comments (TRUNCATED at the marker, preceding whitespace intact)', () => {
    it('truncates a trailing `//` and keeps the whitespace before it', () => {
      expect(codeOnly('const a = 1; // why\n', '.ts')).toBe('const a = 1; ');
    });

    it('truncates a trailing `#` in shell', () => {
      expect(codeOnly('local seam="x" # why\n', '.sh')).toBe('local seam="x" ');
    });

    it('is what stops `foo(); // shell: true` passing through — the #2/#3/#5/#6 hole', () => {
      const stripped = codeOnly("spawn(argv, { shell: false }); // never `shell: true`\n", '.ts');
      expect(stripped).not.toContain('shell: true');
      expect(stripped).toContain('shell: false');
    });
  });

  describe('block comments (OUTSIDE parity — the probe keeps them; one-sided fixture)', () => {
    it('strips a single-line `/* … */`, which survives stripper #2 today', () => {
      expect(codeOnly('const a = /* gone */ 1;\n', '.ts')).toBe('const a =   1;');
    });

    it('strips a multi-line `/** … */` JSDoc block, whose opener survives stripper #2 today', () => {
      const src = '/**\n * MASSU_HOOK_FAILURE_LOG explained here\n */\nconst a = 1;\n';
      expect(codeOnly(src, '.ts')).not.toContain('MASSU_HOOK_FAILURE_LOG');
    });

    it('replaces a block comment with a SPACE so tokens cannot be welded together', () => {
      expect(codeOnly('foo/* c */bar\n', '.ts')).toBe('foo bar');
    });

    it('does NOT treat `/* */` as a comment in a `#` language', () => {
      expect(codeOnly('echo "/* not a comment */"\n', '.sh')).toBe('echo "/* not a comment */"');
    });
  });

  describe('`#!` shebang (OUTSIDE parity — the probe DROPS it; one-sided fixture)', () => {
    it('preserves a shebang: it is executable configuration, not documentation', () => {
      expect(codeOnly('#!/usr/bin/env bash\nset -euo pipefail\n', '.sh')).toBe(
        '#!/usr/bin/env bash\nset -euo pipefail',
      );
    });

    it('preserves a shebang even when the whole rest of the file is comments', () => {
      expect(codeOnly('#!/bin/sh\n# only comments\n', '.sh')).toBe('#!/bin/sh');
    });

    it('still drops a `#` comment on line 2 — only line 1 can be a shebang', () => {
      expect(codeOnly('#!/bin/sh\n# gone\nA=1\n', '.sh')).toBe('#!/bin/sh\nA=1');
    });
  });

  describe('`://` inside a URL (strippers #7 and #8 truncate it)', () => {
    it('does not truncate an unquoted `://`', () => {
      expect(codeOnly('const u = http://a;\n', '.ts')).toBe('const u = http://a;');
    });

    it('keeps a quoted URL AND still strips the real trailing comment after it', () => {
      // OUTSIDE parity: the probe finds the `//` inside the quotes first, sees odd quote
      // parity, and keeps the WHOLE line including the trailing comment.
      expect(codeOnly("const u = 'https://example.com/x'; // why\n", '.ts')).toBe(
        "const u = 'https://example.com/x'; ",
      );
    });
  });

  describe('a marker inside a quoted string is not a comment', () => {
    it('leaves `#` inside double quotes alone in shell', () => {
      expect(codeOnly('echo "a # b"\n', '.sh')).toBe('echo "a # b"');
    });

    it('leaves `#` inside single quotes alone in shell', () => {
      expect(codeOnly("echo 'a # b'\n", '.sh')).toBe("echo 'a # b'");
    });

    it('leaves `//` inside a string alone in TypeScript', () => {
      expect(codeOnly('const s = "a // b";\n', '.ts')).toBe('const s = "a // b";');
    });

    it('handles an escaped quote inside a string without losing the marker state', () => {
      expect(codeOnly('const s = "a\\" # b"; // gone\n', '.ts')).toBe('const s = "a\\" # b"; ');
    });
  });

  describe('fail closed (M2) — an unknown extension THROWS, naming it', () => {
    it('throws on `.rb`, and the message names the extension', () => {
      expect(() => codeOnly('x = 1 # c', '.rb')).toThrow(/\.rb/);
    });

    it('throws rather than returning the input unchanged', () => {
      const src = 'x = 1 # c';
      let returned: unknown = 'NOT THROWN';
      try {
        returned = codeOnly(src, '.rb');
      } catch {
        returned = 'THREW';
      }
      expect(returned).toBe('THREW');
      expect(returned).not.toBe(src);
    });

    it('throws when a whole FILENAME is passed where an extension belongs', () => {
      expect(() => codeOnly('x', 'scripts/x.sh')).toThrow(/unknown extension/);
    });

    it('accepts a dotless extension, and `hasCommentSyntax` throws on the unknown one too', () => {
      expect(codeOnly('A=1\n# gone\n', 'sh')).toBe('A=1');
      expect(() => hasCommentSyntax('.rb')).toThrow(/unknown extension/);
    });
  });

  describe('the THIRD outcome — an extension with no comment syntax yields `null`', () => {
    it('returns null for `.json`, which is neither an error nor a strip', () => {
      expect(codeOnly('{"a": 1}\n', '.json')).toBeNull();
    });

    it('is distinguishable from a strip that produced an empty string', () => {
      expect(codeOnly('# all comments\n', '.sh')).toBe('');
      expect(codeOnly('{"a": 1}', '.json')).toBeNull();
    });

    it('`hasCommentSyntax` agrees with the map for every mapped extension', () => {
      for (const [ext, marker] of Object.entries(LINE_COMMENT)) {
        expect(hasCommentSyntax(ext), ext).toBe(marker !== null);
      }
      expect(Object.keys(LINE_COMMENT).length).toBeGreaterThan(0); // denominator, M1
    });
  });

  describe('`stripStringLiterals` is OPT-IN and defaults FALSE', () => {
    const src = 'console.log("hello");\n';

    it('leaves string literals intact by default', () => {
      expect(codeOnly(src, '.ts')).toBe('console.log("hello");');
    });

    it('blanks them only when asked — stripper #4 s behaviour, preserved for its 6 call sites', () => {
      expect(codeOnly(src, '.ts', { stripStringLiterals: true })).toBe('console.log("");');
    });

    it('blanks single-quoted literals and leaves template literals alone', () => {
      expect(codeOnly("const a = 'x'; const b = `y`;\n", '.ts', { stripStringLiterals: true })).toBe(
        'const a = \'\'; const b = `y`;',
      );
    });
  });

  describe('byte dispositions pinned to the probe', () => {
    it('appends no trailing newline', () => {
      expect(codeOnly('A=1\n', '.sh')).toBe('A=1');
      expect(codeOnly('A=1', '.sh')).toBe('A=1');
    });

    it('treats CRLF input as Python splitlines() does', () => {
      expect(codeOnly('A=1\r\n# gone\r\nB=2\r\n', '.sh')).toBe('A=1\nB=2');
    });

    it('returns an empty string for empty input rather than throwing', () => {
      expect(codeOnly('', '.sh')).toBe('');
    });
  });

  describe('the motivating defect, end to end', () => {
    it('a literal that lives ONLY in a comment does not survive the strip', () => {
      const shell = [
        '#!/usr/bin/env bash',
        '# Reads the A-001 seam (MASSU_HOOK_FAILURE_LOG) and reports UNREADABLE.',
        'main() {',
        '  echo hi',
        '}',
        '',
      ].join('\n');
      const code = codeOnly(shell, '.sh');
      expect(code).not.toBeNull();
      expect(code).not.toContain('MASSU_HOOK_FAILURE_LOG'); // the guard would now go RED
      expect(code).toContain('main() {'); // …and the code is untouched
    });
  });
});
