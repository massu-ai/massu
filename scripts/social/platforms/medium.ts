import { BaseAdapter } from './base.ts';
import { getEnv, isPlatformConfigured } from '../lib/env.ts';
import type { Platform, QueuedPost } from '../lib/types.ts';

const API_BASE = 'https://api.medium.com/v1';

export class MediumAdapter extends BaseAdapter {
  platform: Platform = 'medium';
  private userId: string | null = null;

  isConfigured(): boolean {
    return isPlatformConfigured('medium');
  }

  private async getUserId(): Promise<string> {
    if (this.userId) return this.userId;

    const token = getEnv('MEDIUM_TOKEN');
    const res = await this.fetchJson<{ data: { id: string } }>(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    this.userId = res.data.id;
    return this.userId;
  }

  async publish(post: QueuedPost): Promise<{ url: string }> {
    const token = getEnv('MEDIUM_TOKEN');
    const userId = await this.getUserId();

    const tags = (post.meta.tags || '').split(',').filter(Boolean);
    const publishStatus = post.meta.publishStatus || 'draft';

    const payload = {
      title: post.title,
      contentFormat: 'markdown',
      content: post.body,
      canonicalUrl: post.meta.canonicalUrl || undefined,
      tags: tags.slice(0, 5),
      publishStatus,
    };

    const res = await this.fetchJson<{ data: { id: string; url: string } }>(
      `${API_BASE}/users/${userId}/posts`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      }
    );

    return { url: res.data.url };
  }
}
