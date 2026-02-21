import type { Platform, QueuedPost, PlatformAdapter } from '../lib/types.ts';

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export abstract class BaseAdapter implements PlatformAdapter {
  abstract platform: Platform;
  abstract isConfigured(): boolean;
  abstract publish(post: QueuedPost): Promise<{ url: string }>;

  protected async fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: options.body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.platform} API error (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  protected async fetchText(url: string, options: FetchOptions = {}): Promise<string> {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.platform} API error (${res.status}): ${text}`);
    }

    return res.text();
  }
}
