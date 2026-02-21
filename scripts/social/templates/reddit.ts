import type { ArticleSource, QueuedPost } from '../lib/types.ts';
import { toPlainText, firstSentences, extractKeyParagraphs } from '../lib/formatter.ts';

interface SubredditConfig {
  name: string;
  flair?: string;
  tone: 'technical' | 'practical' | 'discussion';
}

const SUBREDDITS: SubredditConfig[] = [
  { name: 'r/programming', tone: 'technical' },
  { name: 'r/MachineLearning', tone: 'technical' },
  { name: 'r/ClaudeAI', tone: 'practical' },
  { name: 'r/LocalLLaMA', tone: 'discussion' },
];

/** Map article to best-fit subreddits based on content */
function getRelevantSubreddits(article: ArticleSource): SubredditConfig[] {
  // Technical articles go to r/programming + r/MachineLearning
  // Practical/tool articles go to r/ClaudeAI
  // Discussion-oriented go to r/LocalLLaMA
  const slug = article.slug;
  const subs: SubredditConfig[] = [];

  // Always relevant for ClaudeAI
  subs.push(SUBREDDITS.find((s) => s.name === 'r/ClaudeAI')!);

  // Technical articles for r/programming
  if (['the-knowledge-graph', 'the-protocol-system', 'automated-enforcement', 'memory-that-persists'].includes(slug)) {
    subs.push(SUBREDDITS.find((s) => s.name === 'r/programming')!);
  }

  // ML-relevant for r/MachineLearning
  if (['how-i-stopped-vibe-coding', 'context-is-the-bottleneck', 'the-knowledge-graph'].includes(slug)) {
    subs.push(SUBREDDITS.find((s) => s.name === 'r/MachineLearning')!);
  }

  return subs;
}

function generateBody(article: ArticleSource, sub: SubredditConfig): string {
  const keyPoints = extractKeyParagraphs(article.body, 3);

  if (sub.tone === 'technical') {
    return `${article.description}

**Key points:**

${keyPoints.map((p) => `- ${firstSentences(p, 1)}`).join('\n')}

Full article (${article.readingTime} min read): ${article.canonicalUrl}

---
*Part ${article.number}/10 of a series on AI-assisted development governance. Open-source tool: [massu.ai](https://massu.ai)*`;
  }

  if (sub.tone === 'practical') {
    return `${article.description}

${keyPoints[0] || ''}

${article.ctaHeadline}: ${article.ctaDescription}

Full article: ${article.canonicalUrl}

---
*Massu AI is free and open source — 51 MCP tools for Claude Code governance.*`;
  }

  // discussion tone
  return `${article.description}

I wrote about this in depth: ${article.canonicalUrl}

Curious what others think about ${article.subtitle.toLowerCase()}.

---
*From a 10-part series on building enterprise software with AI. [massu.ai](https://massu.ai) is the open-source tool that came out of it.*`;
}

/** Generate Reddit posts for relevant subreddits */
export function articleToRedditPosts(article: ArticleSource): Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'>[] {
  const subs = getRelevantSubreddits(article);

  return subs.map((sub) => ({
    platform: 'reddit' as const,
    contentType: 'article' as const,
    sourceId: `${article.slug}-${sub.name}`,
    title: article.title,
    body: generateBody(article, sub),
    meta: {
      subreddit: sub.name.replace('r/', ''),
      canonicalUrl: article.canonicalUrl,
      articleNumber: String(article.number),
    },
  }));
}
