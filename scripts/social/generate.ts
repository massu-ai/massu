#!/usr/bin/env npx tsx
/**
 * Generate social media posts from website content.
 *
 * Usage:
 *   npx tsx scripts/social/generate.ts --all-articles
 *   npx tsx scripts/social/generate.ts --article how-i-stopped-vibe-coding
 *   npx tsx scripts/social/generate.ts --all-articles --platforms x,linkedin
 *   npx tsx scripts/social/generate.ts --stats --features
 *   npx tsx scripts/social/generate.ts --all-articles --dry-run
 */
import { loadArticles, loadArticle, loadStats, loadFeatures } from './lib/content-reader.ts';
import { addPending } from './lib/queue.ts';
import { loadEnv } from './lib/env.ts';
import { log } from './lib/logger.ts';
import type { Platform, QueuedPost } from './lib/types.ts';

// Templates
import { articleToThread, statToTweet, seriesOverviewThread } from './templates/x.ts';
import { articleToCrossPost } from './templates/medium.ts';
import { articleToRedditPosts } from './templates/reddit.ts';
import { articleToDevtoPost } from './templates/devto.ts';
import { articleToLinkedInPost, statToLinkedInPost, achievementPost } from './templates/linkedin.ts';

loadEnv();

const ALL_PLATFORMS: Platform[] = ['x', 'medium', 'reddit', 'devto', 'linkedin'];

function parseArgs(): {
  articles: string[];
  allArticles: boolean;
  stats: boolean;
  features: boolean;
  platforms: Platform[];
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    articles: [] as string[],
    allArticles: false,
    stats: false,
    features: false,
    platforms: ALL_PLATFORMS,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--all-articles':
        result.allArticles = true;
        break;
      case '--article':
        result.articles.push(args[++i]);
        break;
      case '--stats':
        result.stats = true;
        break;
      case '--features':
        result.features = true;
        break;
      case '--platforms':
        result.platforms = args[++i].split(',') as Platform[];
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      default:
        log.warn(`Unknown flag: ${args[i]}`);
    }
  }

  return result;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const generated: Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'>[] = [];

  log.heading('Social Post Generator');

  if (opts.dryRun) {
    log.info('DRY RUN — posts will not be saved to queue');
  }

  // Generate article posts
  if (opts.allArticles || opts.articles.length > 0) {
    let articles;
    if (opts.allArticles) {
      articles = await loadArticles();
      log.info(`Loaded ${articles.length} articles`);
    } else {
      articles = [];
      for (const slug of opts.articles) {
        const a = await loadArticle(slug);
        if (a) articles.push(a);
        else log.warn(`Article not found: ${slug}`);
      }
    }

    for (const article of articles) {
      log.dim(`Processing: ${article.title}`);

      if (opts.platforms.includes('x')) {
        generated.push(articleToThread(article));
      }
      if (opts.platforms.includes('medium')) {
        generated.push(articleToCrossPost(article));
      }
      if (opts.platforms.includes('reddit')) {
        generated.push(...articleToRedditPosts(article));
      }
      if (opts.platforms.includes('devto')) {
        generated.push(articleToDevtoPost(article));
      }
      if (opts.platforms.includes('linkedin')) {
        generated.push(articleToLinkedInPost(article));
      }
    }

    // Series overview threads (only for all articles)
    if (opts.allArticles && articles.length > 0) {
      if (opts.platforms.includes('x')) {
        generated.push(seriesOverviewThread(articles));
      }
      if (opts.platforms.includes('linkedin')) {
        generated.push(achievementPost(
          '10-part article series on AI-assisted development — now live.',
          'I wrote 10 articles about building enterprise software with AI governance. Every lesson from months of real development, published on massu.ai.'
        ));
      }
    }
  }

  // Generate stat posts
  if (opts.stats) {
    const stats = await loadStats();
    log.info(`Loaded ${stats.length} stats`);

    for (const stat of stats) {
      if (opts.platforms.includes('x')) {
        generated.push(statToTweet(stat));
      }
      if (opts.platforms.includes('linkedin')) {
        generated.push(statToLinkedInPost(stat));
      }
    }
  }

  // Summary
  log.heading('Generated Posts');

  const byPlatform: Record<string, number> = {};
  for (const post of generated) {
    byPlatform[post.platform] = (byPlatform[post.platform] || 0) + 1;
  }

  const rows = Object.entries(byPlatform).map(([platform, count]) => ({
    Platform: platform,
    Count: String(count),
  }));
  log.table(rows);
  log.info(`Total: ${generated.length} posts`);

  if (opts.dryRun) {
    log.heading('Preview (first 5)');
    for (const post of generated.slice(0, 5)) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Platform: ${post.platform} | Type: ${post.contentType}`);
      console.log(`Title: ${post.title}`);
      console.log(`Body (truncated): ${post.body.slice(0, 200)}...`);
    }
    log.info('\nDry run complete. No posts written to queue.');
  } else {
    for (const post of generated) {
      addPending(post);
    }
    log.success(`${generated.length} posts added to pending queue`);
    log.info('Run `npx tsx scripts/social/review.ts` to review and approve');
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
