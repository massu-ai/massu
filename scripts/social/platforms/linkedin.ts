import { BaseAdapter } from './base.ts';
import { getEnv, isPlatformConfigured } from '../lib/env.ts';
import type { Platform, QueuedPost } from '../lib/types.ts';

const API_BASE = 'https://api.linkedin.com/rest';

export class LinkedInAdapter extends BaseAdapter {
  platform: Platform = 'linkedin';

  isConfigured(): boolean {
    return isPlatformConfigured('linkedin');
  }

  async publish(post: QueuedPost): Promise<{ url: string }> {
    const token = getEnv('LINKEDIN_ACCESS_TOKEN');
    const personUrn = getEnv('LINKEDIN_PERSON_URN');

    const payload = {
      author: personUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: post.body,
          },
          shareMediaCategory: 'ARTICLE',
          media: [
            {
              status: 'READY',
              originalUrl: post.meta.canonicalUrl || 'https://massu.ai',
            },
          ],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    const res = await this.fetchJson<{ id: string }>(
      `${API_BASE}/ugcPosts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'LinkedIn-Version': '202401',
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify(payload),
      }
    );

    // LinkedIn UGC post IDs need URL encoding for the activity URL
    const activityId = res.id.replace('urn:li:share:', '');
    return { url: `https://www.linkedin.com/feed/update/urn:li:share:${activityId}` };
  }
}
