import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type { QueuedPost, PostStatus, Platform } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = resolve(__dirname, '..', 'queue');
const PENDING_PATH = resolve(QUEUE_DIR, 'pending.json');
const PUBLISHED_PATH = resolve(QUEUE_DIR, 'published.json');

function readJson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw || raw === '[]') return [];
  return JSON.parse(raw) as T[];
}

function writeJson<T>(path: string, data: T[]): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function getPending(): QueuedPost[] {
  return readJson<QueuedPost>(PENDING_PATH);
}

export function getPublished(): QueuedPost[] {
  return readJson<QueuedPost>(PUBLISHED_PATH);
}

export function addPending(post: Omit<QueuedPost, 'id' | 'status' | 'createdAt' | 'updatedAt'>): QueuedPost {
  const pending = getPending();
  const now = new Date().toISOString();
  const full: QueuedPost = {
    ...post,
    id: randomUUID().slice(0, 8),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  pending.push(full);
  writeJson(PENDING_PATH, pending);
  return full;
}

export function updatePostStatus(id: string, status: PostStatus, extra?: Partial<QueuedPost>): void {
  const pending = getPending();
  const idx = pending.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Post not found: ${id}`);
  pending[idx] = {
    ...pending[idx],
    ...extra,
    status,
    updatedAt: new Date().toISOString(),
  };

  if (status === 'published' || status === 'failed') {
    const published = getPublished();
    published.push(pending[idx]);
    pending.splice(idx, 1);
    writeJson(PENDING_PATH, pending);
    writeJson(PUBLISHED_PATH, published);
  } else {
    writeJson(PENDING_PATH, pending);
  }
}

export function clearPending(): void {
  writeJson(PENDING_PATH, []);
}

export function getPendingByPlatform(platform: Platform): QueuedPost[] {
  return getPending().filter((p) => p.platform === platform);
}

export function getApproved(): QueuedPost[] {
  return getPending().filter((p) => p.status === 'approved');
}

export function getApprovedByPlatform(platform: Platform): QueuedPost[] {
  return getPending().filter((p) => p.status === 'approved' && p.platform === platform);
}

export function generateId(): string {
  return randomUUID().slice(0, 8);
}
