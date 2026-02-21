import type { ArticleSource, StatSource, QueuedPost } from '../lib/types.ts';
import { truncate, firstSentences, toPlainText, formatStat } from '../lib/formatter.ts';

const LI_MAX = 1500;

/** Generate a LinkedIn post from an article */
export function articleToLinkedInPost(article: ArticleSource): Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'> {
  const intro = firstSentences(toPlainText(article.body), 2);

  const body = truncate(
    `${article.title}

${article.subtitle}

${intro}

Key takeaways:

• ${article.ctaHeadline}
• ${article.ctaDescription}
• Part ${article.number}/10 of a series on AI-assisted development

This is from my experience building enterprise software as a solo developer using AI + governance tooling.

Read the full article: ${article.canonicalUrl}

#AIGovernance #ClaudeCode #DevTools #SoftwareEngineering #AI`,
    LI_MAX
  );

  return {
    platform: 'linkedin',
    contentType: 'article',
    sourceId: article.slug,
    title: `LinkedIn: ${article.title}`,
    body,
    meta: {
      canonicalUrl: article.canonicalUrl,
      articleNumber: String(article.number),
    },
  };
}

/** Generate an achievement-style LinkedIn post */
export function achievementPost(milestone: string, detail: string): Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'> {
  const body = truncate(
    `${milestone}

${detail}

Built as an open-source AI governance platform for Claude Code — giving developers the guardrails to ship enterprise-quality software with AI assistance.

What started as a personal system for managing AI code quality has become a full platform:

• 51 MCP tools for code intelligence, memory, and verification
• 11 lifecycle hooks for automated enforcement
• 26 workflow commands for structured development
• Three-database architecture for persistent AI learning

Free and open source: https://massu.ai

#BuildInPublic #AIGovernance #OpenSource #DevTools`,
    LI_MAX
  );

  return {
    platform: 'linkedin',
    contentType: 'achievement',
    sourceId: `achievement-${Date.now()}`,
    title: `Achievement: ${milestone}`,
    body,
    meta: {},
  };
}

/** Generate a stat-focused LinkedIn post */
export function statToLinkedInPost(stat: StatSource): Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'> {
  const formatted = formatStat(stat.value, stat.label, stat.suffix);

  const body = truncate(
    `${formatted}.

That's what Massu AI ships with — an open-source AI governance platform for Claude Code.

Because AI-assisted development needs guardrails, not just speed.

Learn more: https://massu.ai

#AIGovernance #DevTools #OpenSource`,
    LI_MAX
  );

  return {
    platform: 'linkedin',
    contentType: 'stat',
    sourceId: `stat-${stat.label.toLowerCase().replace(/\s+/g, '-')}`,
    title: `Stat: ${formatted}`,
    body,
    meta: { statValue: String(stat.value), statLabel: stat.label },
  };
}
