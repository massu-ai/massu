// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, relative, basename, extname } from 'path';
import { getConfig, getResolvedPaths, getProjectRoot } from './config.ts';

// ============================================================
// Types
// ============================================================

interface IndexStats {
  filesIndexed: number;
  chunksCreated: number;
  edgesCreated: number;
}

interface CRRule {
  rule_id: string;
  rule_text: string;
  vr_type: string;
  reference_path: string;
}

interface VRType {
  vr_type: string;
  command: string;
  expected: string;
  use_when: string;
  catches?: string;
  category?: string;
}

interface IncidentRow {
  incident_num: number;
  date: string;
  type: string;
  gap_found: string;
  prevention: string;
  cr_added?: string;
}

interface SchemaMismatch {
  table_name: string;
  wrong_column: string;
  correct_column: string;
}

interface Section {
  heading: string;
  content: string;
  line_start: number;
  line_end: number;
}

// ============================================================
// Resolved Knowledge Paths
// ============================================================

/**
 * Get resolved paths for knowledge indexing.
 * These are derived from config and project root, not hardcoded.
 */
function getKnowledgePaths() {
  const resolved = getResolvedPaths();
  const config = getConfig();
  const root = getProjectRoot();

  return {
    /** .claude/ directory at project root (config-driven) */
    claudeDir: resolved.claudeDir,

    /** Claude memory directory (user-level, project-scoped, config-driven) */
    memoryDir: resolved.memoryDir,

    /** Plans directory (config-driven) */
    plansDir: resolved.plansDir,

    /** Docs directory (config-driven) */
    docsDir: resolved.docsDir,

    /** Knowledge database path (config-driven) */
    knowledgeDbPath: resolved.knowledgeDbPath,

    /** Project root */
    projectRoot: root,

    /** Project name */
    projectName: config.project.name,
  };
}

// ============================================================
// File Discovery
// ============================================================

function discoverMarkdownFiles(baseDir: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip session-state/archive (ephemeral, 80+ files)
          if (entry.name === 'archive' && dir.includes('session-state')) continue;
          // Skip status/archive
          if (entry.name === 'archive' && dir.includes('status')) continue;
          // Skip node_modules
          if (entry.name === 'node_modules') continue;
          walk(fullPath);
        } else if (entry.isFile() && extname(entry.name) === '.md') {
          files.push(fullPath);
        }
      }
    } catch {
      // Directory may not exist
    }
  }
  walk(baseDir);
  return files;
}

export function categorizeFile(filePath: string): string {
  const paths = getKnowledgePaths();

  // Plan and docs paths checked FIRST — external dirs produce bad relative paths from .claude/
  if (filePath.startsWith(paths.plansDir)) return 'plan';

  // Categorize docs subdirectories
  if (filePath.startsWith(paths.docsDir)) {
    const relFromDocs = relative(paths.docsDir, filePath).replace(/\\/g, '/').toLowerCase();
    if (relFromDocs.startsWith('plans/')) return 'plan';
    if (relFromDocs.includes('architecture')) return 'architecture';
    if (relFromDocs.includes('security')) return 'security';
    if (relFromDocs.includes('deployment')) return 'deployment';
    if (relFromDocs.includes('testing')) return 'testing';
    if (relFromDocs.includes('database')) return 'database-docs';
    if (relFromDocs.includes('audits') || relFromDocs.includes('audit')) return 'audit';
    if (relFromDocs.includes('analysis')) return 'analysis';
    if (relFromDocs.includes('development-intelligence')) return 'dev-intelligence';
    if (relFromDocs.includes('reports')) return 'reports';
    if (relFromDocs.includes('strategy')) return 'strategy';
    return 'docs';
  }

  // Memory directory (user-level Claude memory)
  const claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  if (filePath.includes(`${claudeDirName}/projects/`) && filePath.includes('/memory/')) return 'memory';

  const rel = relative(paths.claudeDir, filePath).replace(/\\/g, '/');
  const firstDir = rel.split('/')[0];
  const knownCategories = getConfig().conventions?.knowledgeCategories ?? [
    'patterns', 'commands', 'incidents', 'reference', 'protocols',
    'checklists', 'playbooks', 'critical', 'scripts', 'status',
    'templates', 'loop-state', 'session-state', 'agents',
  ];
  if (knownCategories.includes(firstDir)) return firstDir;
  // Files at .claude/ root (like CLAUDE.md)
  return 'root';
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ============================================================
// Markdown Parsers
// ============================================================

export function parseCRTable(content: string): CRRule[] {
  const rules: CRRule[] = [];
  // Match CR table rows: | CR-N | Rule text | VR-* | reference |
  const tableRegex = /\|\s*(CR-\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*\[?([^\]|]+)\]?[^|]*\|/g;
  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(content)) !== null) {
    rules.push({
      rule_id: match[1].trim(),
      rule_text: match[2].trim(),
      vr_type: match[3].trim(),
      reference_path: match[4].trim().replace(/\(.*\)/, '').trim(),
    });
  }
  return rules;
}

export function parseVRTable(content: string): VRType[] {
  const types: VRType[] = [];
  // Match VR table rows: | VR-* | `command` | expected | use when |
  const tableRegex = /\|\s*(VR-[\w-]+)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|/g;
  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(content)) !== null) {
    types.push({
      vr_type: match[1].trim(),
      command: match[2].trim(),
      expected: match[3].trim(),
      use_when: match[4].trim(),
    });
  }
  return types;
}

export function parseIncidents(content: string): IncidentRow[] {
  const incidents: IncidentRow[] = [];
  // Match incident summary table rows: | N | date | type | gap | prevention |
  const tableRegex = /\|\s*(\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/g;
  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(content)) !== null) {
    const num = parseInt(match[1].trim(), 10);
    if (isNaN(num) || num === 0) continue; // Skip header
    incidents.push({
      incident_num: num,
      date: match[2].trim(),
      type: match[3].trim(),
      gap_found: match[4].trim(),
      prevention: match[5].trim(),
    });
  }
  return incidents;
}

export function parseSchemaMismatches(content: string): SchemaMismatch[] {
  const mismatches: SchemaMismatch[] = [];
  // Match: | table_name | wrong_column | correct_column |
  // Look for the specific "Known Schema Mismatches" section (stop at next H2/H3 heading, not at ---)
  const sectionMatch = content.match(/### Known Schema Mismatches[\s\S]*?(?=\n##\s|\n---\n|$)/);
  if (!sectionMatch) return mismatches;

  const section = sectionMatch[0];
  // Match table data rows: | word | word | word | (skips header/separator via word-char check)
  const rowRegex = /\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|/g;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(section)) !== null) {
    // Skip header row (has "Table" or "WRONG" etc.)
    if (match[1] === 'Table' || match[2] === 'WRONG' || match[1].startsWith('-')) continue;
    mismatches.push({
      table_name: match[1].trim(),
      wrong_column: match[2].trim(),
      correct_column: match[3].trim(),
    });
  }
  return mismatches;
}

export function parseSections(content: string, _filePath: string): Section[] {
  if (!content.trim()) return [];

  const sections: Section[] = [];
  const lines = content.split('\n');
  let currentHeading = '';
  let currentContent: string[] = [];
  let currentStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{2,3})\s+(.+)/);
    if (headingMatch) {
      // Save previous section
      if (currentContent.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join('\n').trim(),
          line_start: currentStart,
          line_end: i,
        });
      }
      currentHeading = headingMatch[2].trim();
      currentContent = [];
      currentStart = i + 1;
    } else {
      currentContent.push(line);
    }
  }

  // Last section
  if (currentContent.length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join('\n').trim(),
      line_start: currentStart,
      line_end: lines.length,
    });
  }

  return sections;
}

// ============================================================
// Corrections Parser
// ============================================================

export interface CorrectionEntry {
  date: string;
  title: string;
  wrong: string;
  correction: string;
  rule: string;
  cr_rule?: string;
}

export function parseCorrections(content: string): CorrectionEntry[] {
  const entries: CorrectionEntry[] = [];
  const entryRegex = /### (\d{4}-\d{2}-\d{2}) - ([^\n]+)\n([\s\S]*?)(?=\n### |\n## |$)/g;
  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    const block = match[0];
    const date = match[1];
    const title = match[2];
    const wrong = block.match(/\*\*Wrong\*\*:\s*(.+)/)?.[1] || '';
    const correction = block.match(/\*\*Correction\*\*:\s*(.+)/)?.[1] || '';
    const rule = block.match(/\*\*Rule\*\*:\s*(.+)/)?.[1] || '';
    const cr = block.match(/\*\*CR\*\*:\s*(CR-\d+)/)?.[1];
    entries.push({ date, title, wrong, correction, rule, cr_rule: cr });
  }
  return entries;
}

function extractTitle(content: string, filePath: string): string {
  const h1Match = content.match(/^#\s+(.+)/m);
  if (h1Match) return h1Match[1].trim();
  return basename(filePath, '.md');
}

function extractDescription(content: string): string | null {
  // Try frontmatter description
  const fmMatch = content.match(/^---\s*\n[\s\S]*?description:\s*"?([^"\n]+)"?\s*\n[\s\S]*?---/);
  if (fmMatch) return fmMatch[1].trim();
  // First non-heading, non-empty paragraph
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---') && !trimmed.startsWith('|') && trimmed.length > 20) {
      return trimmed.substring(0, 200);
    }
  }
  return null;
}

// ============================================================
// Cross-Reference Builder
// ============================================================

export function buildCrossReferences(db: Database.Database): number {
  let edgeCount = 0;
  const insertEdge = db.prepare(
    'INSERT OR IGNORE INTO knowledge_edges (source_type, source_id, target_type, target_id, edge_type) VALUES (?, ?, ?, ?, ?)'
  );

  // CR -> VR edges (from knowledge_rules)
  const rules = db.prepare('SELECT rule_id, vr_type, reference_path FROM knowledge_rules').all() as CRRule[];
  for (const rule of rules) {
    if (rule.vr_type && rule.vr_type !== 'VR-*') {
      // Split compound VR types (e.g., "VR-SCHEMA" or "VR-*")
      const vrTypes = rule.vr_type.split(/[,\s]+/).filter(v => v.startsWith('VR-'));
      for (const vr of vrTypes) {
        insertEdge.run('cr', rule.rule_id, 'vr', vr, 'enforced_by');
        edgeCount++;
      }
    }
    if (rule.reference_path) {
      const patternName = basename(rule.reference_path, '.md');
      insertEdge.run('cr', rule.rule_id, 'pattern', patternName, 'references');
      edgeCount++;
    }
  }

  // Incident -> CR edges (from knowledge_incidents)
  const incidents = db.prepare('SELECT incident_num, cr_added FROM knowledge_incidents WHERE cr_added IS NOT NULL').all() as { incident_num: number; cr_added: string }[];
  for (const inc of incidents) {
    if (inc.cr_added) {
      const crIds = inc.cr_added.match(/CR-\d+/g) || [];
      for (const crId of crIds) {
        insertEdge.run('incident', String(inc.incident_num), 'cr', crId, 'caused');
        edgeCount++;
      }
    }
  }

  // Scan all chunks for cross-references
  const chunks = db.prepare('SELECT id, content, metadata FROM knowledge_chunks').all() as { id: number; content: string; metadata: string }[];
  for (const chunk of chunks) {
    const text = chunk.content;

    // Find CR references in content
    const crRefs = text.match(/CR-\d+/g);
    if (crRefs) {
      for (const cr of [...new Set(crRefs)]) {
        insertEdge.run('chunk', String(chunk.id), 'cr', cr, 'references');
        edgeCount++;
      }
    }

    // Find VR references
    const vrRefs = text.match(/VR-[\w-]+/g);
    if (vrRefs) {
      for (const vr of [...new Set(vrRefs)]) {
        insertEdge.run('chunk', String(chunk.id), 'vr', vr, 'references');
        edgeCount++;
      }
    }

    // Find incident references
    const incRefs = text.match(/Incident #(\d+)/gi);
    if (incRefs) {
      for (const ref of incRefs) {
        const numMatch = ref.match(/\d+/);
        if (numMatch) {
          insertEdge.run('chunk', String(chunk.id), 'incident', numMatch[0], 'references');
          edgeCount++;
        }
      }
    }
  }

  return edgeCount;
}

// ============================================================
// Indexer Functions
// ============================================================

export function indexAllKnowledge(db: Database.Database): IndexStats {
  const stats: IndexStats = { filesIndexed: 0, chunksCreated: 0, edgesCreated: 0 };
  const paths = getKnowledgePaths();

  const insertDoc = db.prepare(
    'INSERT INTO knowledge_documents (file_path, category, title, description, content_hash, indexed_at, indexed_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertChunk = db.prepare(
    'INSERT INTO knowledge_chunks (document_id, chunk_type, heading, content, line_start, line_end, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertRule = db.prepare(
    'INSERT OR IGNORE INTO knowledge_rules (rule_id, rule_text, vr_type, reference_path) VALUES (?, ?, ?, ?)'
  );
  const insertVR = db.prepare(
    'INSERT OR IGNORE INTO knowledge_verifications (vr_type, command, expected, use_when, catches, category) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertIncident = db.prepare(
    'INSERT OR IGNORE INTO knowledge_incidents (incident_num, date, type, gap_found, prevention) VALUES (?, ?, ?, ?, ?)'
  );
  const insertMismatch = db.prepare(
    'INSERT INTO knowledge_schema_mismatches (table_name, wrong_column, correct_column) VALUES (?, ?, ?)'
  );

  // Discover all .claude/ markdown files
  const files = discoverMarkdownFiles(paths.claudeDir);

  // Also index memory directory (different location)
  try {
    const memFiles = discoverMarkdownFiles(paths.memoryDir);
    files.push(...memFiles);
  } catch {
    // Memory dir may not exist
  }

  // Scan plan documents
  if (existsSync(paths.plansDir)) {
    const planFiles = discoverMarkdownFiles(paths.plansDir);
    files.push(...planFiles);
  }

  // Scan broader docs (skip plans/ since already scanned, skip configured exclude patterns)
  if (existsSync(paths.docsDir)) {
    const excludePatterns = getConfig().conventions?.excludePatterns ?? ['/ARCHIVE/', '/SESSION-HISTORY/'];
    const docsFiles = discoverMarkdownFiles(paths.docsDir)
      .filter(f => !f.includes('/plans/') && !excludePatterns.some(p => f.includes(p)));
    files.push(...docsFiles);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const nowEpoch = now.getTime();

  const transaction = db.transaction(() => {
    // Atomic reindex: clear everything inside transaction so rollback restores data on failure
    // Drop FTS5 triggers before bulk deletion to avoid trigger errors on empty FTS5 table
    db.exec('DROP TRIGGER IF EXISTS kc_fts_delete');
    db.exec('DROP TRIGGER IF EXISTS kc_fts_update');
    db.exec('DELETE FROM knowledge_edges');
    db.exec('DELETE FROM knowledge_fts');
    db.exec('DELETE FROM knowledge_chunks');
    db.exec('DELETE FROM knowledge_documents');
    db.exec('DELETE FROM knowledge_rules');
    db.exec('DELETE FROM knowledge_verifications');
    db.exec('DELETE FROM knowledge_incidents');
    db.exec('DELETE FROM knowledge_schema_mismatches');

    // Recreate FTS5 triggers for the insert phase
    try {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS kc_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
          INSERT INTO knowledge_fts(rowid, heading, content, chunk_type, file_path)
          SELECT new.id, new.heading, new.content, new.chunk_type, kd.file_path
          FROM knowledge_documents kd WHERE kd.id = new.document_id;
        END;
        CREATE TRIGGER IF NOT EXISTS kc_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
          INSERT INTO knowledge_fts(knowledge_fts, rowid, heading, content, chunk_type, file_path)
          SELECT 'delete', old.id, old.heading, old.content, old.chunk_type, kd.file_path
          FROM knowledge_documents kd WHERE kd.id = old.document_id;
        END;
        CREATE TRIGGER IF NOT EXISTS kc_fts_update AFTER UPDATE ON knowledge_chunks BEGIN
          INSERT INTO knowledge_fts(knowledge_fts, rowid, heading, content, chunk_type, file_path)
          SELECT 'delete', old.id, old.heading, old.content, old.chunk_type, kd.file_path
          FROM knowledge_documents kd WHERE kd.id = old.document_id;
          INSERT INTO knowledge_fts(rowid, heading, content, chunk_type, file_path)
          SELECT new.id, new.heading, new.content, new.chunk_type, kd.file_path
          FROM knowledge_documents kd WHERE kd.id = new.document_id;
        END;
      `);
    } catch { /* Triggers may already exist */ }

    for (const filePath of files) {
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, 'utf-8');
      const hash = hashContent(content);
      const relPath = filePath.startsWith(paths.claudeDir)
        ? relative(paths.claudeDir, filePath)
        : filePath.startsWith(paths.plansDir)
        ? 'plans/' + relative(paths.plansDir, filePath)
        : filePath.startsWith(paths.docsDir)
        ? 'docs/' + relative(paths.docsDir, filePath)
        : filePath.startsWith(paths.memoryDir)
        ? `memory/${relative(paths.memoryDir, filePath)}`
        : basename(filePath);
      const category = categorizeFile(filePath);
      const title = extractTitle(content, filePath);
      const description = extractDescription(content);

      // Insert document (documents FIRST — triggers need parent row)
      const result = insertDoc.run(relPath, category, title, description, hash, nowIso, nowEpoch);
      const docId = result.lastInsertRowid;
      stats.filesIndexed++;

      // Parse sections into chunks (triggers auto-populate FTS5)
      const sections = parseSections(content, filePath);
      for (const section of sections) {
        if (section.content.length > 10) { // Skip trivially small sections
          insertChunk.run(docId, 'section', section.heading, section.content, section.line_start, section.line_end, '{}');
          stats.chunksCreated++;
        }
      }

      // Special parsing for specific files
      const fileName = basename(filePath);
      const fileNameLower = fileName.toLowerCase();
      const relPathLower = relPath.toLowerCase();

      // Check if this file is the main CLAUDE.md (config-driven filename)
      const claudeMdName = basename(getResolvedPaths().claudeMdPath).toLowerCase();
      if (fileNameLower === claudeMdName || relPathLower.includes(claudeMdName)) {
        // Extract CR rules
        const crRules = parseCRTable(content);
        for (const rule of crRules) {
          insertRule.run(rule.rule_id, rule.rule_text, rule.vr_type, rule.reference_path);
          insertChunk.run(docId, 'rule', rule.rule_id, `${rule.rule_text} | VR: ${rule.vr_type}`, null, null, JSON.stringify({ cr_id: rule.rule_id, vr_type: rule.vr_type }));
          stats.chunksCreated++;
        }

        // Extract VR types
        const vrTypes = parseVRTable(content);
        for (const vr of vrTypes) {
          insertVR.run(vr.vr_type, vr.command, vr.expected, vr.use_when, vr.catches || null, vr.category || 'core');
        }

        // Extract schema mismatches
        const mismatches = parseSchemaMismatches(content);
        for (const m of mismatches) {
          insertMismatch.run(m.table_name, m.wrong_column, m.correct_column);
          insertChunk.run(docId, 'mismatch', m.table_name, `${m.table_name}: ${m.wrong_column} -> ${m.correct_column}`, null, null, JSON.stringify({ table: m.table_name }));
          stats.chunksCreated++;
        }
      }

      if (fileNameLower === 'incident-log.md') {
        const incidents = parseIncidents(content);
        for (const inc of incidents) {
          insertIncident.run(inc.incident_num, inc.date, inc.type, inc.gap_found, inc.prevention);
          insertChunk.run(docId, 'incident', `Incident #${inc.incident_num}`, `${inc.type}: ${inc.gap_found} | Prevention: ${inc.prevention}`, null, null, JSON.stringify({ incident_num: inc.incident_num }));
          stats.chunksCreated++;
        }
      }

      if (fileNameLower === 'vr-verification-reference.md') {
        const vrTypes = parseVRTable(content);
        for (const vr of vrTypes) {
          insertVR.run(vr.vr_type, vr.command, vr.expected, vr.use_when, vr.catches || null, vr.category || null);
        }
      }

      // Index commands
      if (category === 'commands' && fileName !== '_shared-preamble.md') {
        const cmdName = basename(filePath, '.md');
        insertChunk.run(docId, 'command', cmdName, content.substring(0, 1000), 1, null, JSON.stringify({ command_name: cmdName }));
        stats.chunksCreated++;
      }

      // Parse plan documents for structured metadata
      if (category === 'plan') {
        // Extract plan items (P1-001, P2-001, etc.)
        const planItemRegex = /^###\s+(P\d+-\d+):\s+(.+)$/gm;
        let planMatch;
        while ((planMatch = planItemRegex.exec(content)) !== null) {
          insertChunk.run(docId, 'pattern', planMatch[1], `${planMatch[1]}: ${planMatch[2]}`, null, null, JSON.stringify({ plan_item_id: planMatch[1] }));
          stats.chunksCreated++;
        }

        // Extract IMPLEMENTATION STATUS if present
        const statusMatch = content.match(/# IMPLEMENTATION STATUS[\s\S]*?\n(?=\n#[^#]|\n---|$)/);
        if (statusMatch) {
          insertChunk.run(docId, 'section', 'IMPLEMENTATION STATUS', statusMatch[0], null, null, '{}');
          stats.chunksCreated++;
        }

        // Extract file paths mentioned in plan (src/*, scripts/*)
        const fileRefRegex = /(?:src|scripts)\/[\w\-\/]+\.(?:ts|tsx|sql|md)/g;
        const fileRefs = [...new Set(content.match(fileRefRegex) || [])];
        if (fileRefs.length > 0) {
          const fileRefsChunk = fileRefs.join('\n');
          insertChunk.run(docId, 'section', 'Referenced Files', fileRefsChunk, null, null, JSON.stringify({ file_refs: fileRefs }));
          stats.chunksCreated++;
        }
      }

      // Parse corrections.md for structured correction entries
      if (fileNameLower === 'corrections.md') {
        const corrections = parseCorrections(content);
        for (const c of corrections) {
          insertChunk.run(docId, 'section', `Correction: ${c.title}`,
            `Wrong: ${c.wrong}\nCorrection: ${c.correction}\nRule: ${c.rule}`,
            null, null, JSON.stringify({ is_correction: true, date: c.date, cr_rule: c.cr_rule }));
          stats.chunksCreated++;
          if (c.cr_rule) {
            db.prepare('INSERT OR IGNORE INTO knowledge_edges (source_type, source_id, target_type, target_id, edge_type) VALUES (?, ?, ?, ?, ?)')
              .run('correction', c.title, 'cr', c.cr_rule, 'enforces');
          }
        }
      }
    }

    // Build cross-references after all data inserted
    stats.edgesCreated = buildCrossReferences(db);

    // Update staleness metadata — use current time AFTER indexing to avoid race conditions
    // where files modified during indexing appear stale immediately
    const finalNow = new Date();
    const finalIso = finalNow.toISOString();
    const finalEpoch = finalNow.getTime();
    db.prepare("INSERT OR REPLACE INTO knowledge_meta (key, value) VALUES ('last_index_time', ?)").run(finalIso);
    db.prepare("INSERT OR REPLACE INTO knowledge_meta (key, value) VALUES ('last_index_epoch', ?)").run(String(finalEpoch));
    db.prepare("INSERT OR REPLACE INTO knowledge_meta (key, value) VALUES ('files_indexed', ?)").run(String(stats.filesIndexed));
  });

  transaction();
  return stats;
}

export function isKnowledgeStale(db: Database.Database): boolean {
  const lastEpoch = db.prepare("SELECT value FROM knowledge_meta WHERE key = 'last_index_epoch'").get() as { value: string } | undefined;
  if (!lastEpoch) return true;

  const lastIndexTime = parseInt(lastEpoch.value, 10);
  if (isNaN(lastIndexTime)) return true;

  const paths = getKnowledgePaths();

  // Check if any .claude/ file has been modified since last index
  const files = discoverMarkdownFiles(paths.claudeDir);

  // Also check memory directory for staleness
  try {
    files.push(...discoverMarkdownFiles(paths.memoryDir));
  } catch { /* Memory dir may not exist */ }

  // Also check plans and docs directories for staleness
  if (existsSync(paths.plansDir)) {
    files.push(...discoverMarkdownFiles(paths.plansDir));
  }
  if (existsSync(paths.docsDir)) {
    const excludePatterns = getConfig().conventions?.excludePatterns ?? ['/ARCHIVE/', '/SESSION-HISTORY/'];
    const docsFiles = discoverMarkdownFiles(paths.docsDir)
      .filter(f => !f.includes('/plans/') && !excludePatterns.some(p => f.includes(p)));
    files.push(...docsFiles);
  }

  for (const filePath of files) {
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs > lastIndexTime) return true;
    } catch {
      continue;
    }
  }

  return false;
}

export function indexIfStale(db: Database.Database): IndexStats {
  if (isKnowledgeStale(db)) {
    return indexAllKnowledge(db);
  }
  return { filesIndexed: 0, chunksCreated: 0, edgesCreated: 0 };
}
