// Standard Claude Code hook stdout convention: emit one JSON object per message
// to stdout. The hook protocol expects `{"message": "..."}` shape; the message
// is rendered to the user as advisory text. Using a single helper across all
// hooks closes the structural drift class flagged in plan-stage-d-medium-sweep
// P-M-004 (7 hooks emitted plain text, 3 emitted JSON — half would break if
// Claude Code tightens stdout parsing).
export function writeHookMessage(message: string): void {
  process.stdout.write(JSON.stringify({ message }) + '\n');
}
