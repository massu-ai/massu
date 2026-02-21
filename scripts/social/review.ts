#!/usr/bin/env npx tsx
/**
 * Review and approve/reject pending social media posts.
 *
 * Usage:
 *   npx tsx scripts/social/review.ts                    # Show all pending
 *   npx tsx scripts/social/review.ts --approve <id>     # Approve a specific post
 *   npx tsx scripts/social/review.ts --reject <id>      # Reject a specific post
 *   npx tsx scripts/social/review.ts --approve-all      # Approve all pending
 *   npx tsx scripts/social/review.ts --interactive       # Review one by one
 */
import { getPending, updatePostStatus } from './lib/queue.ts';
import { log } from './lib/logger.ts';
import { createInterface } from 'readline';

function parseArgs(): {
  approveId?: string;
  rejectId?: string;
  approveAll: boolean;
  interactive: boolean;
  platform?: string;
} {
  const args = process.argv.slice(2);
  const result = {
    approveAll: false,
    interactive: false,
  } as ReturnType<typeof parseArgs>;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--approve':
        result.approveId = args[++i];
        break;
      case '--reject':
        result.rejectId = args[++i];
        break;
      case '--approve-all':
        result.approveAll = true;
        break;
      case '--interactive':
        result.interactive = true;
        break;
      case '--platform':
        result.platform = args[++i];
        break;
    }
  }

  return result;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main(): Promise<void> {
  const opts = parseArgs();
  let pending = getPending();

  if (opts.platform) {
    pending = pending.filter((p) => p.platform === opts.platform);
  }

  log.heading('Social Post Review');

  if (pending.length === 0) {
    log.info('No pending posts to review.');
    return;
  }

  // Approve specific post
  if (opts.approveId) {
    const post = pending.find((p) => p.id === opts.approveId);
    if (!post) {
      log.error(`Post not found: ${opts.approveId}`);
      process.exit(1);
    }
    updatePostStatus(opts.approveId, 'approved');
    log.success(`Approved: [${post.platform}] ${post.title}`);
    return;
  }

  // Reject specific post
  if (opts.rejectId) {
    const post = pending.find((p) => p.id === opts.rejectId);
    if (!post) {
      log.error(`Post not found: ${opts.rejectId}`);
      process.exit(1);
    }
    updatePostStatus(opts.rejectId, 'rejected');
    log.success(`Rejected: [${post.platform}] ${post.title}`);
    return;
  }

  // Approve all
  if (opts.approveAll) {
    const pendingOnly = pending.filter((p) => p.status === 'pending');
    for (const post of pendingOnly) {
      updatePostStatus(post.id, 'approved');
    }
    log.success(`Approved ${pendingOnly.length} posts`);
    return;
  }

  // Interactive review
  if (opts.interactive) {
    const pendingOnly = pending.filter((p) => p.status === 'pending');
    log.info(`${pendingOnly.length} posts to review\n`);

    let approved = 0;
    let rejected = 0;
    let skipped = 0;

    for (const post of pendingOnly) {
      console.log(`${'─'.repeat(60)}`);
      console.log(`ID: ${post.id}`);
      console.log(`Platform: ${post.platform} | Type: ${post.contentType}`);
      console.log(`Title: ${post.title}`);
      console.log(`\n${post.body.slice(0, 500)}${post.body.length > 500 ? '...' : ''}\n`);

      const answer = await prompt('[a]pprove / [r]eject / [s]kip / [q]uit? ');

      switch (answer) {
        case 'a':
          updatePostStatus(post.id, 'approved');
          approved++;
          log.success('Approved');
          break;
        case 'r':
          updatePostStatus(post.id, 'rejected');
          rejected++;
          log.warn('Rejected');
          break;
        case 'q':
          log.info(`\nDone: ${approved} approved, ${rejected} rejected, ${skipped} skipped`);
          return;
        default:
          skipped++;
          log.dim('Skipped');
      }
    }

    log.info(`\nDone: ${approved} approved, ${rejected} rejected, ${skipped} skipped`);
    return;
  }

  // Default: show summary
  const byStatus: Record<string, number> = {};
  const byPlatform: Record<string, number> = {};
  for (const post of pending) {
    byStatus[post.status] = (byStatus[post.status] || 0) + 1;
    byPlatform[post.platform] = (byPlatform[post.platform] || 0) + 1;
  }

  log.info(`Total: ${pending.length} posts in queue\n`);

  log.heading('By Status');
  log.table(Object.entries(byStatus).map(([status, count]) => ({ Status: status, Count: String(count) })));

  log.heading('By Platform');
  log.table(Object.entries(byPlatform).map(([platform, count]) => ({ Platform: platform, Count: String(count) })));

  log.heading('Posts');
  log.table(pending.map((p) => ({
    ID: p.id,
    Platform: p.platform,
    Status: p.status,
    Type: p.contentType,
    Title: p.title.slice(0, 50),
  })));

  log.info('\nActions:');
  log.dim('  --approve <id>     Approve a post');
  log.dim('  --reject <id>      Reject a post');
  log.dim('  --approve-all      Approve all pending');
  log.dim('  --interactive      Review one by one');
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
