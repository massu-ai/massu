import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Platform } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '..', '.env.social');

const REQUIRED_KEYS: Record<Platform, string[]> = {
  x: ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'],
  medium: ['MEDIUM_TOKEN'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD'],
  devto: ['DEVTO_API_KEY'],
  linkedin: ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_PERSON_URN'],
};

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  if (!existsSync(ENV_PATH)) return;

  const content = readFileSync(ENV_PATH, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

export function isPlatformConfigured(platform: Platform): boolean {
  loadEnv();
  const keys = REQUIRED_KEYS[platform];
  return keys.every((k) => !!process.env[k]);
}

export function getEnv(key: string): string {
  loadEnv();
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}`);
  return val;
}

export function getMissingKeys(platform: Platform): string[] {
  loadEnv();
  return REQUIRED_KEYS[platform].filter((k) => !process.env[k]);
}
