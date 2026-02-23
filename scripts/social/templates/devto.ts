import type { ArticleSource, QueuedPost } from '../lib/types.ts';
import { stripMdx } from '../lib/formatter.ts';

/** Convert an article to a DEV.to cross-post (technical, code-heavy) */
export function articleToDevtoPost(article: ArticleSource): Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'> {
  const cleanBody = stripMdx(article.body);

  // DEV.to uses liquid tags for metadata at the top
  const body = `---
title: "${article.title}"
published: false
description: "${article.description}"
tags: ai, typescript, devtools, productivity
canonical_url: ${article.canonicalUrl}
cover_image:
series: "${article.series}"
---

${cleanBody}

---

## ${article.ctaHeadline}

${article.ctaDescription}

**[Read the original on massu.ai](${article.canonicalUrl})** | **[GitHub](https://github.com/massu-ai/massu)**

*Part ${article.number}/10 of "${article.series}"*`;

  return {
    platform: 'devto',
    contentType: 'article',
    sourceId: article.slug,
    title: article.title,
    body,
    meta: {
      canonicalUrl: article.canonicalUrl,
      tags: 'ai,typescript,devtools,productivity',
      published: 'false',
      articleNumber: String(article.number),
      series: article.series,
    },
  };
}
