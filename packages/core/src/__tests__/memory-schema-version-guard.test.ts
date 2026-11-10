// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * A change to the memory database's schema must bump MEMORY_SCHEMA_VERSION.
 *
 * The version is what triggers the verified backup taken before massu runs DDL against an
 * existing memory.db (incident 2026-07-13: adding one table corrupted a live database). A
 * schema change without a bump skips that backup silently. memory-db.ts cited a drift-guard
 * for this that did not exist, and three schema changes after v1 shipped without a bump
 * (measured 2026-11-09).
 *
 * How: build a fresh database with the real initMemorySchema, fingerprint every schema object
 * in sqlite_schema (type, name, table, whitespace-normalized SQL — the method miden-node-db
 * publishes for drift detection), and compare with the pinned {version, fingerprint}:
 *   fingerprint changed, version not bumped  -> FAIL: bump MEMORY_SCHEMA_VERSION
 *   version bumped                           -> FAIL until the pin is re-written
 * The pin is an EXPECTATION (G32 option 0), written only by this test's own code:
 *   MASSU_WRITE_SCHEMA_PIN=1 npx vitest run memory-schema-version-guard
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { initMemorySchema, MEMORY_SCHEMA_VERSION } from '../memory-db.ts';

const PIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'memory-schema.pin.json');

export function fingerprintSchema(db: Database.Database): { fingerprint: string; objects: number } {
  const rows = db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const text = rows
    .map((r) => [r.type, r.name, r.tbl_name, (r.sql ?? '').replace(/\s+/g, ' ').trim()].join('\u001f'))
    .join('\n');
  return { fingerprint: createHash('sha256').update(text).digest('hex'), objects: rows.length };
}

function currentSchema() {
  const db = new Database(':memory:');
  try {
    initMemorySchema(db);
    return fingerprintSchema(db);
  } finally {
    db.close();
  }
}

describe('memory schema version guard', () => {
  it('the schema fingerprint matches its pin, or MEMORY_SCHEMA_VERSION was bumped and the pin re-written', () => {
    const now = currentSchema();
    expect(now.objects, 'a fresh schema with no objects would fingerprint vacuously').toBeGreaterThan(20);

    if (process.env.MASSU_WRITE_SCHEMA_PIN === '1') {
      writeFileSync(PIN, JSON.stringify({ version: MEMORY_SCHEMA_VERSION, fingerprint: now.fingerprint, objects: now.objects }, null, 2) + '\n');
    }
    expect(existsSync(PIN), `${PIN} missing — write it with MASSU_WRITE_SCHEMA_PIN=1`).toBe(true);
    const pin = JSON.parse(readFileSync(PIN, 'utf-8')) as { version: number; fingerprint: string };

    if (now.fingerprint !== pin.fingerprint) {
      expect.fail(
        MEMORY_SCHEMA_VERSION === pin.version
          ? `The memory schema changed but MEMORY_SCHEMA_VERSION is still ${pin.version}. Bump it in ` +
            `memory-db.ts (the bump is what triggers the pre-DDL backup), then re-write the pin with ` +
            `MASSU_WRITE_SCHEMA_PIN=1.`
          : `MEMORY_SCHEMA_VERSION is ${MEMORY_SCHEMA_VERSION} and the schema changed: re-write the pin ` +
            `with MASSU_WRITE_SCHEMA_PIN=1 and commit it.`,
      );
    }
    expect(MEMORY_SCHEMA_VERSION, 'version bumped with no schema change, or the pin was not re-written').toBe(pin.version);
  });

  it('control: the fingerprint moves when the schema moves', () => {
    const db = new Database(':memory:');
    try {
      initMemorySchema(db);
      const before = fingerprintSchema(db).fingerprint;
      db.exec('ALTER TABLE session_costs ADD COLUMN av_control INTEGER');
      expect(fingerprintSchema(db).fingerprint).not.toBe(before);
    } finally {
      db.close();
    }
  });
});
