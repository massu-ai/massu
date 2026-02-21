#!/usr/bin/env npx tsx
/**
 * Publish approved social media posts via platform APIs.
 *
 * Usage:
 *   npx tsx scripts/social/publish.ts                     # Publish all approved
 *   npx tsx scripts/social/publish.ts --platform devto     # Publish only DEV.to posts
 *   npx tsx scripts/social/publish.ts --id abc12345        # Publish a specific post
 *   npx tsx scripts/social/publish.ts --dry-run            # Preview without publishing
 */
import { getApproved, getApprovedByPlatform, getPending, updatePostStatus } from './lib/queue.ts';
import { loadEnv, isPlatformConfigured, getMissingKeys } from './lib/env.ts';
import { log } from './lib/logger.ts';
import type { Platform, QueuedPost, PlatformAdapter } from './lib/types.ts';

import { XAdapter } from './platforms/x.ts';
import { MediumAdapter } from './platforms/medium.ts';
import { RedditAdapter } from './platforms/reddit.ts';
import { DevtoAdapter } from './platforms/devto.ts';
import { LinkedInAdapter } from './platforms/linkedin.ts';

loadEnv();

const adapters: Record<Platform, PlatformAdapter> = {
  x: new XAdapter(),
  medium: new MediumAdapter(),
  reddit: new RedditAdapter(),
  devto: new DevtoAdapter(),
  linkedin: new LinkedInAdapter(),
};

function parseArgs(): { platform?: Platform; id?: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  const result = { dryRun: false } as ReturnType<typeof parseArgs>;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--platform':
        result.platform = args[++i] as Platform;
        break;
      case '--id':
        result.id = args[++i];
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
    }
  }

  return result;
}

async function publishPost(post: QueuedPost, adapter: PlatformAdapter, dryRun: boolean): Promise<boolean> {
  if (dryRun) {
    log.dim(`  [DRY RUN] Would publish: [${post.platform}] ${post.title}`);
    return true;
  }

  try {
    const result = await adapter.publish(post);
    updatePostStatus(post.id, 'published', { publishedUrl: result.url });
    log.success(`Published: [${post.platform}] ${post.title}`);
    log.dim(`  URL: ${result.url}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updatePostStatus(post.id, 'failed', { error: message });
    log.error(`Failed: [${post.platform}] ${post.title}`);
    log.dim(`  Error: ${message}`);
    return false;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();

  log.heading('Social Post Publisher');

  if (opts.dryRun) {
    log.info('DRY RUN — posts will not actually be published\n');
  }

  // Publish specific post by ID
  if (opts.id) {
    const pending = getPending();
    const post = pending.find((p) => p.id === opts.id);
    if (!post) {
      log.error(`Post not found: ${opts.id}`);
      process.exit(1);
    }
    if (post.status !== 'approved') {
      log.error(`Post ${opts.id} is not approved (status: ${post.status})`);
      process.exit(1);
    }

    const adapter = adapters[post.platform];
    if (!adapter.isConfigured()) {
      const missing = getMissingKeys(post.platform);
      log.error(`${post.platform} is not configured. Missing: ${missing.join(', ')}`);
      process.exit(1);
    }

    await publishPost(post, adapter, opts.dryRun);
    return;
  }

  // Get posts to publish
  let posts: QueuedPost[];
  if (opts.platform) {
    posts = getApprovedByPlatform(opts.platform);
  } else {
    posts = getApproved();
  }

  if (posts.length === 0) {
    log.info('No approved posts to publish.');
    log.dim('Run `npx tsx scripts/social/review.ts --approve-all` to approve pending posts');
    return;
  }

  // Check platform configuration
  const platforms = [...new Set(posts.map((p) => p.platform))];
  for (const platform of platforms) {
    if (!adapters[platform].isConfigured()) {
      const missing = getMissingKeys(platform);
      log.warn(`${platform} is not configured. Missing: ${missing.join(', ')}. Skipping ${platform} posts.`);
      posts = posts.filter((p) => p.platform !== platform);
    }
  }

  if (posts.length === 0) {
    log.error('No posts can be published — configure API keys in .env.social');
    return;
  }

  log.info(`Publishing ${posts.length} posts...\n`);

  let succeeded = 0;
  let failed = 0;
  let lastPlatform: string | null = null;

  for (const post of posts) {
    // 2s delay between same-platform posts
    if (lastPlatform === post.platform) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    const adapter = adapters[post.platform];
    const ok = await publishPost(post, adapter, opts.dryRun);
    if (ok) succeeded++;
    else failed++;
    lastPlatform = post.platform;
  }

  log.heading('Results');
  log.info(`Succeeded: ${succeeded}`);
  if (failed > 0) log.error(`Failed: ${failed}`);

  if (!opts.dryRun) {
    log.info('\nRun `npx tsx scripts/social/status.ts` to see published posts');
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
