# Social Media Automation Pipeline

Generate, review, and publish social media posts from massu.ai content across 5 platforms.

## Quick Start

```bash
# 1. Generate posts from all articles
npm run social:generate -- --all-articles

# 2. Review and approve
npm run social:review -- --interactive

# 3. Publish approved posts
npm run social:publish

# 4. Check results
npm run social:status
```

## Setup

### 1. Create API Keys

Copy the example env file and fill in your keys:

```bash
cp scripts/social/.env.social.example scripts/social/.env.social
```

### 2. Platform Setup

#### X / Twitter
1. Go to [developer.x.com](https://developer.x.com/en/portal/dashboard)
2. Create a project and app
3. Set app permissions to **Read and Write**
4. Generate OAuth 1.0a keys (consumer key, consumer secret, access token, access token secret)
5. Add all 4 keys to `.env.social`

#### Medium
1. Go to [medium.com/me/settings/security](https://medium.com/me/settings/security)
2. Scroll to "Integration tokens"
3. Generate a new token
4. Add `MEDIUM_TOKEN` to `.env.social`

#### Reddit
1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Create a new app (type: **script**)
3. Note the client ID (under the app name) and secret
4. Add client ID, secret, username, and password to `.env.social`

#### DEV.to
1. Go to [dev.to/settings/extensions](https://dev.to/settings/extensions)
2. Under "DEV Community API Keys", generate a new key
3. Add `DEVTO_API_KEY` to `.env.social`

#### LinkedIn
1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps)
2. Create an app and request the `w_member_social` permission
3. Generate an access token via OAuth 2.0
4. Find your person URN: `urn:li:person:XXXXXXXXX`
5. Add token and URN to `.env.social`

## Commands

### Generate

```bash
# All articles to all platforms
npm run social:generate -- --all-articles

# Specific article
npm run social:generate -- --article how-i-stopped-vibe-coding

# Only certain platforms
npm run social:generate -- --all-articles --platforms x,linkedin

# Stats and features
npm run social:generate -- --stats --features

# Preview without saving
npm run social:generate -- --all-articles --dry-run
```

### Review

```bash
# Show all pending posts
npm run social:review

# Approve/reject specific posts
npm run social:review -- --approve abc123
npm run social:review -- --reject abc123

# Approve all pending
npm run social:review -- --approve-all

# Interactive one-by-one review
npm run social:review -- --interactive
```

### Publish

```bash
# Publish all approved posts
npm run social:publish

# Single platform
npm run social:publish -- --platform devto

# Specific post
npm run social:publish -- --id abc123

# Preview without publishing
npm run social:publish -- --dry-run
```

### Status

```bash
# Show all published
npm run social:status

# Filter by platform
npm run social:status -- --platform x

# Filter by date
npm run social:status -- --since 2026-02-01
```

## Architecture

```
[MDX Articles + Data Files] → content-reader → generate.ts → pending.json
                                                    ↓ (templates)
                                          [User reviews via review.ts]
                                                    ↓
                                    publish.ts → platform adapters → APIs
                                        ↓
                                  published.json → status.ts
```

### Content Sources
- `website/content/articles/*.mdx` — 10 articles with YAML frontmatter
- `website/src/data/features.ts` — 51 MCP tools with descriptions
- `website/src/data/stats.ts` — Marketing stats
- `website/src/data/pricing.ts` — 4 pricing tiers
- `website/src/data/articles.ts` — Article CTAs

### Platform-Specific Behavior
| Platform | Auth | Format | Default |
|----------|------|--------|---------|
| X | OAuth 1.0a | Threads (5-7 tweets) | Published |
| Medium | Bearer token | Full markdown cross-post | **Draft** |
| Reddit | OAuth 2.0 | Self-post, subreddit-specific | Published |
| DEV.to | API key | Full markdown with frontmatter | **Draft** |
| LinkedIn | Bearer token | Plain text, 1500 char max | Published |

### Safety Features
- Medium and DEV.to publish as **drafts** by default
- All cross-posts include canonical URLs (SEO protection)
- 2-second delay between same-platform API calls
- Human review step required before publishing
- Queue files are human-readable JSON
