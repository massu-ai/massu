/**
 * A secret-file check tests a PATH, never a substring of the command text.
 *
 * ── Two occurrences, same shape, both real ────────────────────────────────────────
 *
 * The judgement lived as two shell one-liners in `.claude/settings.json`, matching an
 * extension pattern against the whole Bash command string:
 *
 *   2026-08-12  no end anchor, so the key extension matched inside `Object.keys(` and
 *               ordinary commands were refused three times in one session. The repair
 *               appended an end anchor to ONE of the two inline sites; the staged-file
 *               matcher kept the unanchored form (CR-74 — a fix is a set of SITES).
 *   2026-09-22  the anchored form STILL refused a command whose prose mentioned the
 *               Node process environment object, because the dotenv extension followed
 *               by a dot satisfies the anchor. An end anchor cannot help when the
 *               character after the extension is legitimately a dot.
 *
 * The memory for #1 says in terms: "First occurrence ⇒ incident + memory; a recurrence
 * is #2 and earns a gate." This file is that gate.
 *
 * ── Why these assertions ──────────────────────────────────────────────────────────
 *
 * A gate that fires on compliant input is a defect of equal standing to a miss — it is
 * on a path to being routed around or switched off. So the NEGATIVE cases are asserted
 * with the same weight as the positive ones, and each is drawn from something that
 * actually happened rather than invented.
 */
import { describe, it, expect } from 'vitest';
import { namesSecretFile, secretFilesInCommand } from '../hooks/security-gate.ts';

describe('a secret-file reference is a path, not a substring', () => {
  describe('the two real false positives must stay allowed', () => {
    it('OCCURRENCE 1 (2026-08-12): a property access whose name begins with an extension', () => {
      // `Object.keys(` — the key extension is a PREFIX of `keys`.
      expect(secretFilesInCommand('node -e "console.log(Object.keys(x))"')).toEqual([]);
      expect(secretFilesInCommand("jq '.a|keys[]' file.json")).toEqual([]);
    });

    it('OCCURRENCE 2 (2026-09-22): the Node process environment object', () => {
      const envRef = ['process', 'env', 'CI'].join('.');
      expect(secretFilesInCommand(`echo "the harness keys this on ${envRef}"`)).toEqual([]);
      expect(secretFilesInCommand(`grep -n ${envRef} src/app.ts`)).toEqual([]);
      // …and the bare object, which the anchored pattern also matched.
      expect(secretFilesInCommand('grep -rn process' + '.env src/')).toEqual([]);
    });

    it('a quoted program is ONE token, so its contents are never read as argv', () => {
      // This is the structural reason #2 cannot recur: the prose lived inside a quoted
      // heredoc body, and a substring matcher has no notion of quoting.
      const inside = ['config', 'env'].join('.');
      expect(secretFilesInCommand(`python3 -c 'print("${inside}")'`)).toEqual([]);
    });

    it('template dotenv files are permitted BY NAME, retiring the sed pre-pass', () => {
      for (const suffix of ['example', 'template', 'sample', 'defaults', 'dist']) {
        const name = ['.env', suffix].join('.');
        expect(namesSecretFile(name), `${name} should be permitted`).toBeNull();
      }
    });
  });

  describe('real secret files must still be refused', () => {
    it('a dotenv file, bare or in a path', () => {
      expect(namesSecretFile('.env')).not.toBeNull();
      expect(namesSecretFile('apps/web/.env')).not.toBeNull();
      expect(namesSecretFile(['.env', 'local'].join('.'))).not.toBeNull();
      expect(namesSecretFile(['.env', 'production'].join('.'))).not.toBeNull();
    });

    it('certificate, key and keystore extensions', () => {
      for (const ext of ['pem', 'key', 'p12', 'pfx', 'secret']) {
        const name = ['server', ext].join('.');
        expect(namesSecretFile(name), `${name} should be refused`).not.toBeNull();
      }
    });

    it('private keys and credential files named exactly', () => {
      for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa', '.netrc', 'kubeconfig',
                          'credentials.json', 'secrets.yaml', 'secrets.yml']) {
        expect(namesSecretFile(name), `${name} should be refused`).not.toBeNull();
      }
      expect(namesSecretFile('~/.aws/credentials')).not.toBeNull();
      expect(namesSecretFile('~/.ssh/config')).not.toBeNull();
    });

    it('a whole command naming one is refused, and NAMES which file', () => {
      const hits = secretFilesInCommand('cat deploy/server' + '.pem | base64');
      expect(hits.length, 'the command names a certificate').toBeGreaterThan(0);
      expect(hits[0]).toContain('pem');
    });

    it('NEGATIVE CONTROL: the predicate is not simply always-null', () => {
      // "It stopped blocking the thing I wanted" and "it stopped blocking anything"
      // look identical from the positive case alone — the 2026-08-12 memory says so in
      // terms, and that is why this assertion exists.
      const allowed = ['Object.keys(x)', 'package.json', 'src/index.ts', 'README.md'];
      const refused = ['.env', 'id_rsa', 'a/b/server' + '.pem'];
      expect(allowed.filter((t) => namesSecretFile(t) !== null),
        'no ordinary path may be refused').toEqual([]);
      expect(refused.filter((t) => namesSecretFile(t) === null),
        'every secret file must be refused').toEqual([]);
    });
  });

  describe('the inline duplicates are gone', () => {
    it('no shell one-liner in settings.json judges secret files any more', async () => {
      const { readFileSync } = await import('fs');
      const { join, dirname, resolve } = await import('path');
      const { fileURLToPath } = await import('url');
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
      const raw = readFileSync(join(root, '.claude/settings.json'), 'utf-8');

      // Two inline matchers carried this concern, and they had already drifted apart.
      // One predicate, one list, one file — or the drift returns.
      expect(raw, 'an inline secret-file matcher is back in settings.json')
        .not.toContain('Detected secret file in command');
      expect(raw, 'an inline staged-secret matcher is back in settings.json')
        .not.toContain('Secret file staged');
    });
  });
});
