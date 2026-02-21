import { BaseAdapter } from './base.ts';
import { getEnv, isPlatformConfigured } from '../lib/env.ts';
import type { Platform, QueuedPost } from '../lib/types.ts';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';
const USER_AGENT = 'massu-social-bot/1.0';

export class RedditAdapter extends BaseAdapter {
  platform: Platform = 'reddit';
  private accessToken: string | null = null;

  isConfigured(): boolean {
    return isPlatformConfigured('reddit');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    const clientId = getEnv('REDDIT_CLIENT_ID');
    const clientSecret = getEnv('REDDIT_CLIENT_SECRET');
    const username = getEnv('REDDIT_USERNAME');
    const password = getEnv('REDDIT_PASSWORD');

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    });

    if (!res.ok) {
      throw new Error(`Reddit auth failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { access_token: string };
    this.accessToken = data.access_token;
    return this.accessToken;
  }

  async publish(post: QueuedPost): Promise<{ url: string }> {
    const token = await this.getAccessToken();
    const subreddit = post.meta.subreddit;
    if (!subreddit) throw new Error('Reddit post missing subreddit in meta');

    const params = new URLSearchParams({
      sr: subreddit,
      kind: 'self',
      title: post.title,
      text: post.body,
      resubmit: 'true',
    });

    const res = await fetch(`${API_BASE}/api/submit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: params.toString(),
    });

    if (!res.ok) {
      throw new Error(`Reddit submit failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      json: { data: { url: string } };
    };

    return { url: data.json.data.url };
  }
}
