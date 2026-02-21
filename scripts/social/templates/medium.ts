import type { ArticleSource, QueuedPost } from '../lib/types.ts';
import { stripMdx } from '../lib/formatter.ts';

/** Convert an article to a Medium cross-post (full markdown) */
export function articleToCrossPost(article: ArticleSource): Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'> {
  const cleanBody = stripMdx(article.body);

  const body = `# ${article.title}

*${article.subtitle}*

*Part ${article.number}/10 of "${article.series}"*

---

${cleanBody}

---

## ${article.ctaHeadline}

${article.ctaDescription}

**[Read the original on massu.ai](${article.canonicalUrl})**

**[Try Massu AI — Free & Open Source](https://massu.ai)**`;

  // Medium allows max 5 tags
  const tags = ['ai-governance', 'claude-code', 'developer-tools', 'ai-coding', 'typescript'];

  return {
    platform: 'medium',
    contentType: 'article',
    sourceId: article.slug,
    title: article.title,
    body,
    meta: {
      canonicalUrl: article.canonicalUrl,
      tags: tags.join(','),
      publishStatus: 'draft',
      articleNumber: String(article.number),
    },
  };
}
