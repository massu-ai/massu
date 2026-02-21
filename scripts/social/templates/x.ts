import type { ArticleSource, StatSource, QueuedPost } from '../lib/types.ts';
import { truncate, toPlainText, extractKeyParagraphs, formatStat } from '../lib/formatter.ts';

const TWEET_MAX = 280;
const TAGS = '#AIGovernance #ClaudeCode #DevTools';

/** Generate a thread (5-7 tweets) from an article */
export function articleToThread(article: ArticleSource): Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'> {
  const keyPoints = extractKeyParagraphs(article.body, 4);

  const parts: string[] = [];

  // Tweet 1: Hook
  parts.push(truncate(
    `${article.title}\n\n${article.subtitle}\n\nA thread 🧵`,
    TWEET_MAX
  ));

  // Tweet 2: The problem
  if (keyPoints[0]) {
    parts.push(truncate(keyPoints[0], TWEET_MAX));
  }

  // Tweets 3-5: Key takeaways
  for (let i = 1; i < Math.min(keyPoints.length, 4); i++) {
    parts.push(truncate(keyPoints[i], TWEET_MAX));
  }

  // Tweet 6: CTA
  parts.push(truncate(
    `${article.ctaHeadline}\n\n${article.ctaDescription}\n\nRead the full article: ${article.canonicalUrl}`,
    TWEET_MAX
  ));

  // Tweet 7: Tags
  parts.push(truncate(
    `Part ${article.number}/10 of "${article.series}"\n\n${TAGS}\n\n${article.canonicalUrl}`,
    TWEET_MAX
  ));

  return {
    platform: 'x',
    contentType: 'article',
    sourceId: article.slug,
    title: `Thread: ${article.title}`,
    body: parts.join('\n\n---\n\n'),
    threadParts: parts,
    meta: {
      articleNumber: String(article.number),
      series: article.series,
    },
  };
}

/** Generate a single tweet from a stat */
export function statToTweet(stat: StatSource): Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'> {
  const formatted = formatStat(stat.value, stat.label, stat.suffix);
  const body = truncate(
    `${formatted}.\n\nMassu AI ships with ${formatted.toLowerCase()} — all free and open source.\n\nGovernance for AI-assisted development.\n\nhttps://massu.ai\n\n${TAGS}`,
    TWEET_MAX
  );

  return {
    platform: 'x',
    contentType: 'stat',
    sourceId: `stat-${stat.label.toLowerCase().replace(/\s+/g, '-')}`,
    title: `Stat: ${formatted}`,
    body,
    meta: { statValue: String(stat.value), statLabel: stat.label },
  };
}

/** Generate a series overview thread */
export function seriesOverviewThread(articles: ArticleSource[]): Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'> {
  const parts: string[] = [];

  parts.push(truncate(
    `"Building Enterprise Software with AI" — a 10-part series on massu.ai\n\nHow one developer built enterprise-grade software using AI + governance.\n\nEvery lesson, every failure, every solution. A thread 🧵`,
    TWEET_MAX
  ));

  // Group articles in pairs to fit tweet limits
  for (let i = 0; i < articles.length; i += 2) {
    const lines = articles.slice(i, i + 2).map(
      (a) => `${a.number}. ${a.title}`
    );
    parts.push(truncate(lines.join('\n\n'), TWEET_MAX));
  }

  parts.push(truncate(
    `All 10 articles are live now.\n\nFree to read. No paywall.\n\nhttps://massu.ai/articles\n\n${TAGS}`,
    TWEET_MAX
  ));

  return {
    platform: 'x',
    contentType: 'series-overview',
    sourceId: 'series-overview',
    title: 'Series Overview Thread',
    body: parts.join('\n\n---\n\n'),
    threadParts: parts,
    meta: { articleCount: String(articles.length) },
  };
}
