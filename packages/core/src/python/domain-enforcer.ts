// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type Database from 'better-sqlite3';
import { getConfig } from '../config.ts';

export interface DomainViolation {
  sourceFile: string;
  sourceDomain: string;
  targetFile: string;
  targetDomain: string;
}

/**
 * Classify a Python file into its domain based on python.domains config.
 */
export function classifyPythonFileDomain(file: string): string {
  const config = getConfig();
  const domains = config.python?.domains || [];
  const pythonRoot = config.python?.root || '';

  let modulePath = file;
  if (pythonRoot && modulePath.startsWith(pythonRoot + '/')) {
    modulePath = modulePath.slice(pythonRoot.length + 1);
  }
  modulePath = modulePath.replace(/\/__init__\.py$/, '').replace(/\.py$/, '').replace(/\//g, '.');

  for (const domain of domains) {
    for (const pkg of domain.packages) {
      if (modulePath.startsWith(pkg) || modulePath === pkg) {
        return domain.name;
      }
    }
  }
  return 'Unknown';
}

/**
 * Find all cross-domain import violations in the Python import graph.
 */
export function findPythonDomainViolations(dataDb: Database.Database): DomainViolation[] {
  const config = getConfig();
  const domains = config.python?.domains || [];
  if (domains.length === 0) return [];

  const imports = dataDb.prepare(
    'SELECT source_file, target_file FROM massu_py_imports'
  ).all() as { source_file: string; target_file: string }[];

  const violations: DomainViolation[] = [];

  for (const imp of imports) {
    const srcDomain = classifyPythonFileDomain(imp.source_file);
    const tgtDomain = classifyPythonFileDomain(imp.target_file);

    if (srcDomain === tgtDomain || srcDomain === 'Unknown' || tgtDomain === 'Unknown') continue;

    const srcConfig = domains.find(d => d.name === srcDomain);
    if (srcConfig && !srcConfig.allowed_imports_from.includes(tgtDomain)) {
      violations.push({
        sourceFile: imp.source_file,
        sourceDomain: srcDomain,
        targetFile: imp.target_file,
        targetDomain: tgtDomain,
      });
    }
  }

  return violations;
}

/**
 * Get all Python files in a specific domain.
 */
export function getPythonFilesInDomain(dataDb: Database.Database, domainName: string): string[] {
  const allFiles = dataDb.prepare(
    'SELECT DISTINCT source_file as f FROM massu_py_imports UNION SELECT DISTINCT target_file as f FROM massu_py_imports'
  ).all() as { f: string }[];

  return allFiles
    .map(row => row.f)
    .filter(f => classifyPythonFileDomain(f) === domainName);
}
