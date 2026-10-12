/**
 * The security gate's Python rules must judge CODE, not prose — and must still see real calls.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every `DANGEROUS_PYTHON_PATTERNS` entry matched the RAW edit text, so a comment describing
 * `os.system(...)`, or a TEST FIXTURE holding it as a string, fired the gate. Measured in one
 * session on 2026-08-19: three firings, all three prose, none an actual call. This is the
 * third detector on this machine to make the same mistake — see the memories
 * `a-scanner-that-reads-prose-as-code` and `a-detector-must-be-scoped-to-what-it-may-judge`,
 * and the G29 census predicate that read a wrapped `description` field as a git invocation.
 *
 * `checkPythonContent` was never directly tested before this file. A rule with no test is a
 * rule nobody has shown can reject — or accept.
 *
 * THE DIRECTION OF THE RISK DECIDES THE SHAPE OF THESE TESTS. A false positive here is noise
 * (the finding is `warn`, exit 0). A FALSE NEGATIVE is a missed security warning, so the
 * must-still-fire cases outnumber the must-stay-silent ones and the fallback is asserted
 * explicitly: an edit fragment that cannot be lexed falls back to the RAW text.
 */
import { describe, it, expect } from 'vitest';
import { runSecurityGateFindings, stripPythonCommentsAndStringBodies } from '../hooks/security-gate.ts';

function pyFinding(newString: string): string | null {
  const findings = runSecurityGateFindings({
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/example.py', new_string: newString },
  });
  const py = findings.find((f) => f.message.includes('Dangerous Python pattern'));
  return py ? py.message.split('\n')[0] : null;
}

describe('the lexer keeps code and drops prose', () => {
  it('empties a string body but keeps the quotes and everything around them', () => {
    expect(stripPythonCommentsAndStringBodies('x = "os.system(1)"\ny = 2\n'))
      .toBe('x = ""\ny = 2\n');
  });

  it('drops a comment without eating the newline', () => {
    expect(stripPythonCommentsAndStringBodies('a = 1  # os.system(x)\nb = 2\n'))
      .toBe('a = 1  \nb = 2\n');
  });

  it('leaves a real call completely untouched', () => {
    // THE LOAD-BEARING CASE. The call name lives outside any quotes, so emptying string
    // bodies cannot remove it — which is why this transformation is safe for `code` rules.
    expect(stripPythonCommentsAndStringBodies('import os\nos.system(cmd)\n'))
      .toBe('import os\nos.system(cmd)\n');
  });

  it('handles triple-quoted docstrings spanning lines', () => {
    expect(stripPythonCommentsAndStringBodies('"""os.system(x)\nmore prose"""\nz = 1\n'))
      .toBe('""""""\nz = 1\n');
  });

  it('does not treat a # inside a string as a comment', () => {
    expect(stripPythonCommentsAndStringBodies('u = "a # b"\nv = 3\n')).toBe('u = ""\nv = 3\n');
  });

  it('returns null on an unterminated string — the untrusted-fragment signal', () => {
    // An Edit fragment routinely starts or ends mid-construct. Returning null is what makes
    // the caller fall back to raw text instead of reading real code as string body.
    expect(stripPythonCommentsAndStringBodies('x = "unterminated\n')).toBeNull();
    expect(stripPythonCommentsAndStringBodies('"""never closed\n')).toBeNull();
  });
});

describe('MUST STILL FIRE — a false negative is a missed security warning', () => {
  const realCalls: Array<[string, string]> = [
    ['os.system', 'import os\nos.system(cmd)\n'],
    ['eval', 'value = eval(user_input)\n'],
    ['exec', 'exec(compiled)\n'],
    ['__import__', 'mod = __import__(name)\n'],
    ['subprocess.call shell=True', 'subprocess.call(cmd, shell=True)\n'],
    ['subprocess.Popen shell=True', 'subprocess.Popen(cmd, shell=True)\n'],
  ];
  for (const [label, src] of realCalls) {
    it(`${label} is still detected after comment/string stripping`, () => {
      expect(pyFinding(src)).not.toBeNull();
    });
  }

  it('a call still fires when the same file also mentions it in a comment', () => {
    expect(pyFinding('# never call os.system(x) directly\nimport os\nos.system(cmd)\n')).not.toBeNull();
  });

  it('an UNLEXABLE fragment falls back to raw matching rather than going quiet', () => {
    // The fragment opens a string and never closes it, so the lexer refuses. The gate must
    // still warn — noisier, never blinder.
    expect(stripPythonCommentsAndStringBodies('os.system(cmd)\nmsg = "oops\n')).toBeNull();
    expect(pyFinding('os.system(cmd)\nmsg = "oops\n')).not.toBeNull();
  });

  it('both SQL rules are scoped RAW and still fire — they are ABOUT string content', () => {
    // ⛔ THE REGRESSION THE SCOPE FIELD EXISTS TO PREVENT. Blanket-applying the strip would
    // empty the very strings these two rules examine, deleting them silently.
    //
    // NOTE THE SHAPE, WHICH IS NARROWER THAN IT LOOKS. Both patterns require the
    // `execute`/`cursor`/`query` keyword AFTER the closing quote, on the SAME LINE (no `s`
    // flag, so `.*` cannot cross a newline). My first fixtures here were
    // `cursor.execute(f"select {col} …")` — keyword FIRST — and they did not match, which is
    // a fact about the patterns, not about this fix. Recorded rather than papered over: these
    // two rules see an assign-then-execute line and miss the inline call entirely.
    expect(pyFinding('sql = f"select {col} from t"; cursor.execute(sql)\n')).not.toBeNull();
    expect(pyFinding('sql = "select %s from t" % col; cursor.execute(sql)\n')).not.toBeNull();
  });

  it('the SQL rules are UNCHANGED by this fix — same verdict before and after stripping', () => {
    // The scope field is only meaningful if 'raw' really bypasses the strip. Emptying the
    // string bodies of these lines destroys the match, so this asserts the two subjects
    // genuinely differ — otherwise `scope: 'raw'` would be decoration.
    const line = 'sql = f"select {col} from t"; cursor.execute(sql)\n';
    const stripped = stripPythonCommentsAndStringBodies(line);
    expect(stripped).not.toBeNull();
    expect(/\bf['"].*\{.*\}.*['"].*(?:execute|cursor|query)/.test(line)).toBe(true);
    expect(/\bf['"].*\{.*\}.*['"].*(?:execute|cursor|query)/.test(stripped as string)).toBe(false);
  });
});

describe('MUST STAY SILENT — the three real firings from 2026-08-19', () => {
  it('a comment describing the pattern is not a call', () => {
    // The command inside is INCIDENTAL to what this asserts — the property is "a mention of
    // os.system inside a comment is not a call". It reads `deploy --all` rather than the real
    // edit's text because this repo's own G29 guard reads a repo-creating command inside a TS
    // STRING as code (see the incident, §6). Changing the fixture's payload costs this test
    // nothing; changing `os.system` would have been fixing the fixture, and is not done.
    expect(pyFinding('#: `os` is the gap: os.system(f"deploy --all {d}") classified DATA\nX = 1\n')).toBeNull();
  });

  it('a test fixture holding the call as a string is data, not a call', () => {
    expect(pyFinding('FIXTURES = [\n    ("py: os.system", \'import os\\nos.system(f"deploy --all")\'),\n]\n')).toBeNull();
  });

  it('a vocabulary of attribute NAMES is not a call', () => {
    // ⛔ THIS ONE PASSES BOTH BEFORE AND AFTER THE FIX, and saying so is the point (G20).
    // Measured by mutation: reverting to raw matching turns the other three RED and leaves
    // this one green, because `frozenset({"system", …})` contains no `os.system(` even raw —
    // the real trigger on 2026-08-19 was the COMMENT beside it, which is the test above.
    // It is kept as a WIDENING GUARD, not a regression catcher: the obvious "fix" for a
    // missed `os.system` is to drop the `\(` from the pattern, and that would convict every
    // vocabulary table on the machine.
    expect(pyFinding('"os": frozenset({\n    "system", "popen", "execv",\n}),\n')).toBeNull();
  });

  it('a docstring describing the risk is not a call', () => {
    expect(pyFinding('"""Never use os.system() — it is a shell injection risk."""\nY = 2\n')).toBeNull();
  });
});
