// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Sentinel: Feature Registry Type Definitions
// ============================================================

export type FeatureStatus = 'planned' | 'active' | 'deprecated' | 'removed';
export type FeaturePriority = 'critical' | 'standard' | 'nice-to-have';
export type ComponentRole = 'implementation' | 'ui' | 'data' | 'utility';
export type DependencyType = 'requires' | 'enhances' | 'replaces';
export type ChangeType = 'created' | 'updated' | 'deprecated' | 'removed' | 'restored';

export interface Feature {
  id: number;
  feature_key: string;
  domain: string;
  subdomain: string | null;
  title: string;
  description: string | null;
  status: FeatureStatus;
  priority: FeaturePriority;
  portal_scope: string[]; // Parsed from JSON
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  removed_reason: string | null;
}

export interface FeatureInput {
  feature_key: string;
  domain: string;
  subdomain?: string;
  title: string;
  description?: string;
  status?: FeatureStatus;
  priority?: FeaturePriority;
  portal_scope?: string[];
}

export interface FeatureComponent {
  id: number;
  feature_id: number;
  component_file: string;
  component_name: string | null;
  role: ComponentRole;
  is_primary: boolean;
}

export interface FeatureProcedure {
  id: number;
  feature_id: number;
  router_name: string;
  procedure_name: string;
  procedure_type: string | null;
}

export interface FeaturePage {
  id: number;
  feature_id: number;
  page_route: string;
  portal: string | null;
}

export interface FeatureDep {
  id: number;
  feature_id: number;
  depends_on_feature_id: number;
  dependency_type: DependencyType;
}

export interface FeatureChangeLog {
  id: number;
  feature_id: number;
  change_type: ChangeType;
  changed_by: string | null;
  change_detail: string | null;
  commit_hash: string | null;
  created_at: string;
}

export interface FeatureWithCounts extends Feature {
  component_count: number;
  procedure_count: number;
  page_count: number;
}

export interface FeatureDetail extends Feature {
  components: FeatureComponent[];
  procedures: FeatureProcedure[];
  pages: FeaturePage[];
  dependencies: FeatureDep[];
  changelog: FeatureChangeLog[];
}

export interface ImpactItem {
  feature: Feature;
  affected_files: string[];
  remaining_files: string[];
  status: 'orphaned' | 'degraded' | 'unaffected';
}

export interface ImpactReport {
  files_analyzed: string[];
  orphaned: ImpactItem[];
  degraded: ImpactItem[];
  unaffected: ImpactItem[];
  blocked: boolean;
  block_reason: string | null;
}

export interface ValidationItem {
  feature: Feature;
  missing_components: string[];
  missing_procedures: { router: string; procedure: string }[];
  missing_pages: string[];
  status: 'alive' | 'orphaned' | 'degraded';
}

export interface ValidationReport {
  alive: number;
  orphaned: number;
  degraded: number;
  details: ValidationItem[];
}

export interface ParityItem {
  feature_key: string;
  title: string;
  status: 'DONE' | 'GAP' | 'NEW';
  old_files: string[];
  new_files: string[];
}

export interface ParityReport {
  done: ParityItem[];
  gaps: ParityItem[];
  new_features: ParityItem[];
  parity_percentage: number;
}
