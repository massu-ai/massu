import { BaseAdapter } from './base.ts';
import { getEnv, isPlatformConfigured } from '../lib/env.ts';
import type { Platform, QueuedPost } from '../lib/types.ts';

const API_BASE = 'https://dev.to/api';

export class DevtoAdapter extends BaseAdapter {
  platform: Platform = 'devto';

  isConfigured(): boolean {
    return isPlatformConfigured('devto');
  }

  async publish(post: QueuedPost): Promise<{ url: string }> {
    const apiKey = getEnv('DEVTO_API_KEY');
    const tags = (post.meta.tags || '').split(',').filter(Boolean).slice(0, 4);

    const payload = {
      article: {
        title: post.title,
        body_markdown: post.body,
        published: post.meta.published === 'true',
        tags,
        canonical_url: post.meta.canonicalUrl || undefined,
        series: post.meta.series || undefined,
      },
    };

    const res = await this.fetchJson<{ id: number; url: string }>(
      `${API_BASE}/articles`,
      {
        method: 'POST',
        headers: { 'api-key': apiKey },
        body: JSON.stringify(payload),
      }
    );

    return { url: res.url };
  }
}
