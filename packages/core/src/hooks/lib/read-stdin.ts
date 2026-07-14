/**
 * THE ONE STDIN READER for hooks.
 *
 * WHY THIS EXISTS (S-3, the silent-failure class, 2026-07-12):
 * Every hook hand-rolled this:
 *
 *     process.stdin.on('end', () => resolve(data));
 *     setTimeout(() => resolve(data), 400);   // "Timeout to prevent hanging"
 *
 * That `setTimeout` resolves the promise with whatever bytes arrived in 400ms —
 * i.e. with TRUNCATED JSON — and reports it as a successful read. The caller then
 * did `JSON.parse(partial)`, which threw, straight into an empty `catch {}`, then
 * `process.exit(0)`.
 *
 * For the PreToolUse SECURITY gate, `exit 0` means ALLOW. So a command the gate
 * never finished reading was byte-for-byte indistinguishable from a command it had
 * read and approved. The gate's failure mode was to permit.
 *
 * THE FIX: the caller must be able to tell "I read the whole payload" apart from
 * "I gave up". This reader RESOLVES on EOF and REJECTS on deadline — it never hands
 * back a partial buffer dressed up as a complete one. What the caller does about a
 * rejection is a policy decision, and for a security gate the only correct policy is
 * to DENY (see pre-tool-use-gate.ts).
 */

export class StdinTimeoutError extends Error {
  readonly bytesRead: number;
  constructor(ms: number, bytesRead: number) {
    super(
      `stdin did not reach EOF within ${ms}ms (${bytesRead} bytes read). ` +
        `The payload is INCOMPLETE and must not be treated as valid input.`,
    );
    this.name = 'StdinTimeoutError';
    this.bytesRead = bytesRead;
  }
}

/**
 * Read stdin to EOF.
 *
 * @param deadlineMs Hard deadline. Claude Code requires hooks to finish within 5s;
 *   the old 400ms budget was not a hook-latency limit but an arbitrary number that
 *   silently truncated large payloads (a long file `content`, a long command).
 * @throws {StdinTimeoutError} if EOF is not reached before the deadline. NEVER
 *   returns a partial buffer — that is the entire point of this module.
 */
export function readStdinToEof(deadlineMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // REJECT — do not resolve with `data`. A partial read is a failed read.
      reject(new StdinTimeoutError(deadlineMs, data.length));
    }, deadlineMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => finish(() => resolve(data)));
    process.stdin.on('error', (err) => finish(() => reject(err)));
  });
}
