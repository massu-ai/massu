import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import type { ArticleSource, StatSource, FeatureSource, PricingSource } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = resolve(__dirname, '..', '..', '..', 'website');
const ARTICLES_DIR = resolve(WEBSITE_ROOT, 'content', 'articles');
const DATA_DIR = resolve(WEBSITE_ROOT, 'src', 'data');

const SITE_URL = process.env.SITE_URL || 'https://massu.ai';

/** Parse YAML frontmatter from MDX content */
function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { data: {}, body: content };

  const data: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    data[key] = val;
  }

  return { data, body: match[2] };
}

/** Load all articles from MDX files with CTA data */
export async function loadArticles(): Promise<ArticleSource[]> {
  // Dynamic import the CTA data
  const articlesModule = await import(resolve(DATA_DIR, 'articles.ts'));
  const ctas: Record<string, { headline: string; description: string }> = articlesModule.articleCTAs;

  const files = readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.mdx'));
  const articles: ArticleSource[] = [];

  for (const file of files) {
    const raw = readFileSync(resolve(ARTICLES_DIR, file), 'utf-8');
    const { data, body } = parseFrontmatter(raw);
    const slug = data.slug || basename(file, '.mdx');
    const cta = ctas[slug] || { headline: '', description: '' };

    articles.push({
      slug,
      number: parseInt(data.number, 10) || 0,
      title: data.title || '',
      subtitle: data.subtitle || '',
      description: data.description || '',
      date: data.date || '',
      readingTime: parseInt(data.readingTime, 10) || 0,
      series: data.series || '',
      body,
      ctaHeadline: cta.headline,
      ctaDescription: cta.description,
      canonicalUrl: `${SITE_URL}/articles/${slug}`,
    });
  }

  return articles.sort((a, b) => a.number - b.number);
}

/** Load a single article by slug */
export async function loadArticle(slug: string): Promise<ArticleSource | null> {
  const articles = await loadArticles();
  return articles.find((a) => a.slug === slug) || null;
}

/** Load stats from data file */
export async function loadStats(): Promise<StatSource[]> {
  const mod = await import(resolve(DATA_DIR, 'stats.ts'));
  return mod.stats as StatSource[];
}

/** Load features from data file */
export async function loadFeatures(): Promise<FeatureSource[]> {
  const mod = await import(resolve(DATA_DIR, 'features.ts'));
  return mod.features as FeatureSource[];
}

/** Load pricing tiers from data file */
export async function loadPricing(): Promise<PricingSource[]> {
  const mod = await import(resolve(DATA_DIR, 'pricing.ts'));
  return (mod.pricingTiers as PricingSource[]).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    monthlyPrice: t.monthlyPrice,
    annualPrice: t.annualPrice,
    features: t.features,
  }));
}
