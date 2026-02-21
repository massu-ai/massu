import { createHmac, randomBytes } from 'crypto';
import { BaseAdapter } from './base.ts';
import { getEnv, isPlatformConfigured } from '../lib/env.ts';
import type { Platform, QueuedPost } from '../lib/types.ts';

const API_BASE = 'https://api.x.com/2';

/** Percent-encode per RFC 3986 */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Generate OAuth 1.0a signature */
function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string
): string {
  const sortedKeys = Object.keys(params).sort();
  const paramStr = sortedKeys.map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const baseStr = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramStr)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac('sha1', signingKey).update(baseStr).digest('base64');
}

/** Build OAuth 1.0a Authorization header */
function buildOAuthHeader(method: string, url: string, bodyParams?: Record<string, string>): string {
  const apiKey = getEnv('X_API_KEY');
  const apiSecret = getEnv('X_API_SECRET');
  const accessToken = getEnv('X_ACCESS_TOKEN');
  const accessSecret = getEnv('X_ACCESS_TOKEN_SECRET');

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };

  const allParams = { ...oauthParams, ...bodyParams };
  oauthParams.oauth_signature = generateOAuthSignature(method, url, allParams, apiSecret, accessSecret);

  const headerStr = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return `OAuth ${headerStr}`;
}

export class XAdapter extends BaseAdapter {
  platform: Platform = 'x';

  isConfigured(): boolean {
    return isPlatformConfigured('x');
  }

  async publish(post: QueuedPost): Promise<{ url: string }> {
    if (post.threadParts && post.threadParts.length > 1) {
      return this.publishThread(post.threadParts);
    }
    return this.publishTweet(post.body);
  }

  private async publishTweet(text: string, replyToId?: string): Promise<{ url: string }> {
    const url = `${API_BASE}/tweets`;
    const payload: Record<string, unknown> = { text };
    if (replyToId) {
      payload.reply = { in_reply_to_tweet_id: replyToId };
    }

    const body = JSON.stringify(payload);
    const auth = buildOAuthHeader('POST', url);

    const res = await this.fetchJson<{ data: { id: string } }>(url, {
      method: 'POST',
      headers: { Authorization: auth },
      body,
    });

    return { url: `https://x.com/i/status/${res.data.id}` };
  }

  private async publishThread(parts: string[]): Promise<{ url: string }> {
    let firstUrl = '';
    let previousId: string | undefined;

    for (const part of parts) {
      const url = `${API_BASE}/tweets`;
      const payload: Record<string, unknown> = { text: part };
      if (previousId) {
        payload.reply = { in_reply_to_tweet_id: previousId };
      }

      const body = JSON.stringify(payload);
      const auth = buildOAuthHeader('POST', url);

      const res = await this.fetchJson<{ data: { id: string } }>(url, {
        method: 'POST',
        headers: { Authorization: auth },
        body,
      });

      if (!firstUrl) {
        firstUrl = `https://x.com/i/status/${res.data.id}`;
      }
      previousId = res.data.id;

      // Rate limit protection: wait 1s between tweets
      if (parts.indexOf(part) < parts.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return { url: firstUrl };
  }
}
