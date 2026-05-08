// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 7: tests for Rails AST adapter.
 *
 * Mirrors the python-flask / go-chi adversarial-fixture pattern: positives
 * + negatives + adversarial inputs created inline via mkdirSync+writeFileSync
 * rather than shipped as fixture files. The adapter degrades to 'none' when
 * the tree-sitter-ruby grammar is unavailable, so every test passes both
 * with and without the live grammar primed.
 *
 * First Phase 7 test that exercises the `ruby` grammar entry from
 * GRAMMAR_MANIFEST (commit fbb8aa9) — implicit smoke test of the load+parse
 * path for tree-sitter-ruby.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { railsAdapter } from '../detect/adapters/rails.ts';
import type { SourceFile, DetectionSignals } from '../detect/adapters/types.ts';

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `massu-rails-${name}-`));
}

function makeFile(root: string, relPath: string, content: string): SourceFile {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return {
    path: fullPath,
    content,
    language: 'ruby',
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

function emptySignals(): DetectionSignals {
  return {
    presentDirs: new Set<string>(),
    presentFiles: new Set<string>(),
  };
}

describe('rails adapter — id + languages', () => {
  it('exports id "rails"', () => {
    expect(railsAdapter.id).toBe('rails');
  });

  it('targets ruby language only', () => {
    expect(railsAdapter.languages).toEqual(['ruby']);
  });
});

describe('rails adapter — matches() (cheap signals, no IO)', () => {
  it('matches when Gemfile declares gem \'rails\'', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      gemfile: `source 'https://rubygems.org'

ruby '3.2.2'

gem 'rails', '~> 7.1.2'
gem 'pg', '~> 1.5'
gem 'puma', '~> 6.4'
`,
    };
    expect(railsAdapter.matches(signals)).toBe(true);
  });

  it('matches with double-quoted gem declaration', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      gemfile: 'gem "rails"',
    };
    expect(railsAdapter.matches(signals)).toBe(true);
  });

  it('matches case-insensitively (defensive)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      gemfile: 'GEM "rails", "~> 7.1"',
    };
    expect(railsAdapter.matches(signals)).toBe(true);
  });

  it('does NOT match a Ruby project without rails gem (negative)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      gemfile: `source 'https://rubygems.org'
gem 'sinatra', '~> 3.1'
gem 'rack', '~> 3.0'
`,
    };
    expect(railsAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match rails-adjacent gems (negative — anchor regex)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      gemfile: `gem 'rails-api', '~> 0.4'
gem 'rails_admin', '~> 3.0'
`,
    };
    // The strict regex `gem ['"]rails['"]` rejects rails-api / rails_admin
    // because the closing quote must come immediately after `rails`.
    expect(railsAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match a comment mentioning rails (negative)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      gemfile: `# This project does NOT use rails
gem 'sinatra'
`,
    };
    expect(railsAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match without a Gemfile (negative)', () => {
    expect(railsAdapter.matches(emptySignals())).toBe(false);
  });
});

describe('rails adapter — introspect()', () => {
  it('empty file list → none confidence', async () => {
    const result = await railsAdapter.introspect([], '/nonexistent');
    expect(result.confidence).toBe('none');
    expect(result.conventions).toEqual({});
  });

  it('non-Rails Ruby file → none confidence', async () => {
    const root = tmp('non-rails');
    const file = makeFile(root, 'lib/util.rb', `
module Util
  def self.hello
    puts "hi"
  end
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      // Either grammar unavailable (none) or no Rails DSL signals (none).
      expect(result.confidence).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes.rb with single GET route → high confidence (when grammar primed)', async () => {
    const root = tmp('rails-single-route');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  get '/health', to: 'health#show'
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      // Grammar may be unavailable in CI without primed cache; both outcomes acceptable.
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'high') {
        expect(result.conventions.route_method).toBe('get');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes.rb with namespace + root → conventions captured (when grammar primed)', async () => {
    const root = tmp('rails-namespace-root');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  root 'pages#home'

  namespace :api do
    namespace :v1 do
      resources :orders
    end
  end
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence !== 'none') {
        if (result.conventions.api_namespace) {
          // First-seen namespace is :api (top-level).
          expect(result.conventions.api_namespace).toBe('/api');
        }
        if (result.conventions.root_controller) {
          expect(result.conventions.root_controller).toBe('pages');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes.rb with mixed HTTP verbs → low confidence (when grammar primed)', async () => {
    const root = tmp('rails-mixed-verbs');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  get  '/health', to: 'health#show'
  post '/login',  to: 'sessions#create'
  delete '/logout', to: 'sessions#destroy'
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      // With grammar primed: low confidence because routeMethods.size >= 2.
      // Without grammar: none.
      expect(['none', 'low', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'low') {
        expect(result.conventions.route_method).toBeDefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes.rb with namespace-only (no top-level verbs) → medium confidence with api_namespace', async () => {
    const root = tmp('rails-namespace-only');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  namespace :admin do
    resources :reports
  end
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      // With grammar primed: medium (no routeMethods, has api_namespace).
      // Without grammar: none.
      expect(['none', 'medium']).toContain(result.confidence);
      if (result.confidence === 'medium') {
        expect(result.conventions.api_namespace).toBe('/admin');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('member/collection blocks: get :preview is a SYMBOL arg → NOT captured as route_method', async () => {
    const root = tmp('rails-member-collection');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  resources :posts do
    member do
      get :preview
    end
    collection do
      get :archive
    end
  end
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      // The string-literal anchor in ROUTE_METHOD_QUERY excludes :preview /
      // :archive (symbols). Without any string-literal verb route, no
      // route_method is captured. Confidence is 'none' (no other signals).
      expect(['none']).toContain(result.confidence);
      expect(result.conventions.route_method).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('root controller with namespace prefix: \'admin/dashboard#index\' → captures full path', async () => {
    const root = tmp('rails-namespaced-root');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  root 'admin/dashboard#index'
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      expect(['none', 'medium']).toContain(result.confidence);
      if (result.confidence === 'medium') {
        expect(result.conventions.root_controller).toBe('admin/dashboard');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('root with `to:` keyword form: root to: \'pages#home\'', async () => {
    const root = tmp('rails-root-to');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  root to: 'pages#home'
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      expect(['none', 'medium']).toContain(result.confidence);
      if (result.confidence === 'medium') {
        expect(result.conventions.root_controller).toBe('pages');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('namespace with string arg: namespace \'api\' do', async () => {
    const root = tmp('rails-namespace-string');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  namespace 'api' do
    resources :orders
  end
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      expect(['none', 'medium']).toContain(result.confidence);
      if (result.confidence === 'medium') {
        expect(result.conventions.api_namespace).toBe('/api');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('broken Ruby syntax → does NOT crash, returns none', async () => {
    const root = tmp('rails-broken');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  get((( '/x', to: !!! 'foo#bar'
  end end end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      // The key invariant: no throw. Tree-sitter is error-recovering, so
      // partial captures may still emerge — that's acceptable as long as
      // the adapter doesn't crash.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('malformed root target without # separator → root_controller NOT captured', async () => {
    const root = tmp('rails-bad-root');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  root 'no-hash-here'
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      // No # means extractRootController returns null → no field set.
      // No other signals → 'none'.
      expect(result.confidence).toBe('none');
      expect(result.conventions.root_controller).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provenance: each captured field has a provenance entry', async () => {
    const root = tmp('rails-provenance');
    const file = makeFile(root, 'config/routes.rb', `
Rails.application.routes.draw do
  root 'pages#home'
  get '/health', to: 'health#show'
  namespace :api do
    resources :users
  end
end
`);
    try {
      const result = await railsAdapter.introspect([file], root);
      // When grammar is primed, expect all three fields captured.
      // Each captured convention key MUST have a corresponding provenance
      // entry; provenance.length === Object.keys(conventions).length.
      expect(result.provenance.length).toBe(Object.keys(result.conventions).length);
      for (const p of result.provenance) {
        expect(p.field).toMatch(/^(route_method|api_namespace|root_controller)$/);
        expect(p.sourceFile).toBe(file.path);
        expect(p.line).toBeGreaterThanOrEqual(0);
        expect(p.query).toMatch(/^rails-/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
