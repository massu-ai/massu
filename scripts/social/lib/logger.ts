const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

export const log = {
  info(msg: string): void {
    console.log(`${BLUE}ℹ${RESET} ${msg}`);
  },
  success(msg: string): void {
    console.log(`${GREEN}✓${RESET} ${msg}`);
  },
  warn(msg: string): void {
    console.log(`${YELLOW}⚠${RESET} ${msg}`);
  },
  error(msg: string): void {
    console.error(`${RED}✗${RESET} ${msg}`);
  },
  heading(msg: string): void {
    console.log(`\n${BOLD}${CYAN}${msg}${RESET}`);
  },
  dim(msg: string): void {
    console.log(`${DIM}${msg}${RESET}`);
  },
  table(rows: Record<string, string>[]): void {
    if (rows.length === 0) return;
    const keys = Object.keys(rows[0]);
    const widths = keys.map((k) =>
      Math.max(k.length, ...rows.map((r) => (r[k] || '').length))
    );
    const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
    const sep = widths.map((w) => '─'.repeat(w)).join('──');
    console.log(`${DIM}${header}${RESET}`);
    console.log(`${DIM}${sep}${RESET}`);
    for (const row of rows) {
      console.log(keys.map((k, i) => (row[k] || '').padEnd(widths[i])).join('  '));
    }
  },
};
