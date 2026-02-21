#!/usr/bin/env npx tsx
/**
 * Show published post history and status.
 *
 * Usage:
 *   npx tsx scripts/social/status.ts                      # Show all published
 *   npx tsx scripts/social/status.ts --platform x          # Filter by platform
 *   npx tsx scripts/social/status.ts --since 2026-02-01    # Filter by date
 */
import { getPublished, getPending } from './lib/queue.ts';
import { log } from './lib/logger.ts';
import type { Platform } from './lib/types.ts';

function parseArgs(): { platform?: Platform; since?: string } {
  const args = process.argv.slice(2);
  const result = {} as ReturnType<typeof parseArgs>;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--platform':
        result.platform = args[++i] as Platform;
        break;
      case '--since':
        result.since = args[++i];
        break;
    }
  }

  return result;
}

function main(): void {
  const opts = parseArgs();

  log.heading('Social Media Status');

  // Pending summary
  const pending = getPending();
  const byPendingStatus: Record<string, number> = {};
  for (const p of pending) {
    byPendingStatus[p.status] = (byPendingStatus[p.status] || 0) + 1;
  }

  log.heading('Queue');
  if (pending.length === 0) {
    log.info('Queue is empty');
  } else {
    log.table(Object.entries(byPendingStatus).map(([status, count]) => ({
      Status: status,
      Count: String(count),
    })));
  }

  // Published posts
  let published = getPublished();

  if (opts.platform) {
    published = published.filter((p) => p.platform === opts.platform);
  }
  if (opts.since) {
    const since = new Date(opts.since);
    published = published.filter((p) => new Date(p.updatedAt) >= since);
  }

  log.heading('Published');

  if (published.length === 0) {
    log.info('No published posts yet.');
    return;
  }

  // Summary by platform
  const byPlatform: Record<string, { total: number; success: number; failed: number }> = {};
  for (const post of published) {
    if (!byPlatform[post.platform]) {
      byPlatform[post.platform] = { total: 0, success: 0, failed: 0 };
    }
    byPlatform[post.platform].total++;
    if (post.status === 'published') byPlatform[post.platform].success++;
    if (post.status === 'failed') byPlatform[post.platform].failed++;
  }

  log.table(Object.entries(byPlatform).map(([platform, counts]) => ({
    Platform: platform,
    Total: String(counts.total),
    Success: String(counts.success),
    Failed: String(counts.failed),
  })));

  // Post details
  log.heading('Post Details');
  log.table(published.map((p) => ({
    ID: p.id,
    Platform: p.platform,
    Status: p.status,
    Title: p.title.slice(0, 40),
    URL: p.publishedUrl || p.error || '—',
    Date: p.updatedAt.slice(0, 10),
  })));

  log.info(`\nTotal: ${published.length} posts`);
}

main();
