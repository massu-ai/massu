export type Platform = 'x' | 'medium' | 'reddit' | 'devto' | 'linkedin';

export type ContentType = 'article' | 'stat' | 'feature' | 'achievement' | 'series-overview';

export type PostStatus = 'pending' | 'approved' | 'rejected' | 'published' | 'failed';

export interface QueuedPost {
  id: string;
  platform: Platform;
  contentType: ContentType;
  /** Source slug or identifier */
  sourceId: string;
  title: string;
  body: string;
  /** For thread-based platforms (X) */
  threadParts?: string[];
  /** Platform-specific metadata */
  meta: Record<string, string>;
  status: PostStatus;
  createdAt: string;
  updatedAt: string;
  /** URL after publishing */
  publishedUrl?: string;
  /** Error message if failed */
  error?: string;
}

export interface ArticleSource {
  slug: string;
  number: number;
  title: string;
  subtitle: string;
  description: string;
  date: string;
  readingTime: number;
  series: string;
  /** Raw MDX body (frontmatter stripped) */
  body: string;
  /** CTA headline from articles.ts */
  ctaHeadline: string;
  /** CTA description from articles.ts */
  ctaDescription: string;
  canonicalUrl: string;
}

export interface StatSource {
  value: number;
  label: string;
  suffix: string;
}

export interface FeatureSource {
  name: string;
  description: string;
  benefit: string;
  tier: string;
  category: string;
}

export interface PricingSource {
  id: string;
  name: string;
  description: string;
  monthlyPrice: number | null;
  annualPrice: number | null;
  features: string[];
}

export interface PlatformAdapter {
  platform: Platform;
  isConfigured(): boolean;
  publish(post: QueuedPost): Promise<{ url: string }>;
}

export interface GenerateOptions {
  articles?: string[];
  allArticles?: boolean;
  stats?: boolean;
  features?: boolean;
  platforms?: Platform[];
  dryRun?: boolean;
}

export interface PublishOptions {
  platform?: Platform;
  id?: string;
  dryRun?: boolean;
}

export interface StatusOptions {
  platform?: Platform;
  since?: string;
}
