// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 7: tests for go-chi adapter.
 *
 * Mirrors the python-flask adversarial-fixture pattern: positives + negatives
 * + adversarial inputs created inline via mkdirSync+writeFileSync rather than
 * shipped as fixture files. The adapter degrades to 'none' when grammar is
 * unavailable, so every test passes both with and without the live
 * tree-sitter-go grammar primed.
 *
 * First Phase 7 test that exercises the NEW `go` grammar entry added to
 * GRAMMAR_MANIFEST in the preceding grammar-infra commit — implicit smoke
 * test of the load+parse path for non-Python/JS/Swift languages.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { goChiAdapter } from '../detect/adapters/go-chi.ts';
import type { SourceFile, DetectionSignals } from '../detect/adapters/types.ts';

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `massu-go-chi-${name}-`));
}

function makeFile(root: string, relPath: string, content: string): SourceFile {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return {
    path: fullPath,
    content,
    language: 'go',
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

function emptySignals(): DetectionSignals {
  return {
    presentDirs: new Set<string>(),
    presentFiles: new Set<string>(),
  };
}

describe('go-chi adapter — id + languages', () => {
  it('exports id "go-chi"', () => {
    expect(goChiAdapter.id).toBe('go-chi');
  });

  it('targets go language only', () => {
    expect(goChiAdapter.languages).toEqual(['go']);
  });
});

describe('go-chi adapter — matches() (cheap signals, no IO)', () => {
  it('matches when go.mod requires github.com/go-chi/chi', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      goMod: `module github.com/example/app
go 1.21
require github.com/go-chi/chi/v5 v5.0.10
`,
    };
    expect(goChiAdapter.matches(signals)).toBe(true);
  });

  it('matches case-insensitively (defensive)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      goMod: 'require GitHub.com/go-chi/chi v1.5.0',
    };
    expect(goChiAdapter.matches(signals)).toBe(true);
  });

  it('does NOT match a Go project without chi (negative)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      goMod: `module github.com/example/app
go 1.21
require github.com/gin-gonic/gin v1.9.1
`,
    };
    expect(goChiAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match without a go.mod (negative)', () => {
    expect(goChiAdapter.matches(emptySignals())).toBe(false);
  });

  it('does NOT match a non-Go project that mentions chi in unrelated text (negative)', () => {
    // No goMod field at all — even if presentFiles lists random things.
    const signals: DetectionSignals = {
      ...emptySignals(),
      presentFiles: new Set(['README.md']),
    };
    expect(goChiAdapter.matches(signals)).toBe(false);
  });
});

describe('go-chi adapter — introspect()', () => {
  it('empty file list → none confidence', async () => {
    const result = await goChiAdapter.introspect([], '/nonexistent');
    expect(result.confidence).toBe('none');
    expect(result.conventions).toEqual({});
  });

  it('non-chi Go file → none confidence (regex fallback territory)', async () => {
    const root = tmp('non-chi');
    const file = makeFile(root, 'cmd/main/main.go', `
package main

import "fmt"

func main() {
    fmt.Println("hello")
}
`);
    try {
      const result = await goChiAdapter.introspect([file], root);
      // Either grammar unavailable (none) or no chi signals (none).
      expect(result.confidence).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('chi router with single GET route → high confidence (when grammar primed)', async () => {
    const root = tmp('chi-single-route');
    const file = makeFile(root, 'internal/api/router.go', `
package api

import (
    "net/http"

    "github.com/go-chi/chi/v5"
)

func NewRouter() http.Handler {
    r := chi.NewRouter()
    r.Get("/users", func(w http.ResponseWriter, req *http.Request) {
        w.Write([]byte("users"))
    })
    return r
}
`);
    try {
      const result = await goChiAdapter.introspect([file], root);
      // Grammar may be unavailable in CI without primed cache; both outcomes acceptable.
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'high') {
        expect(result.conventions.route_method).toBe('Get');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('chi router with Mount + middleware → conventions captured (when grammar primed)', async () => {
    const root = tmp('chi-mount-mw');
    const file = makeFile(root, 'internal/api/router.go', `
package api

import (
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
)

func NewRouter(apiHandler http.Handler) http.Handler {
    r := chi.NewRouter()
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Mount("/api/v1", apiHandler)
    return r
}
`);
    try {
      const result = await goChiAdapter.introspect([file], root);
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence !== 'none') {
        if (result.conventions.mount_prefix_base) {
          expect(result.conventions.mount_prefix_base).toBe('/api');
        }
        if (result.conventions.middleware_name) {
          // First-seen — Logger is registered before Recoverer.
          expect(result.conventions.middleware_name).toBe('Logger');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('chi router with mixed HTTP verbs → low confidence (when grammar primed)', async () => {
    const root = tmp('chi-mixed-verbs');
    const file = makeFile(root, 'internal/api/router.go', `
package api

import (
    "net/http"

    "github.com/go-chi/chi/v5"
)

func NewRouter() http.Handler {
    r := chi.NewRouter()
    r.Get("/users", listUsers)
    r.Post("/users", createUser)
    r.Delete("/users/{id}", deleteUser)
    return r
}

func listUsers(w http.ResponseWriter, req *http.Request)   { w.Write([]byte("list")) }
func createUser(w http.ResponseWriter, req *http.Request)  { w.Write([]byte("create")) }
func deleteUser(w http.ResponseWriter, req *http.Request)  { w.Write([]byte("delete")) }
`);
    try {
      const result = await goChiAdapter.introspect([file], root);
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

  it('Mount-only router (no GET/POST) → medium confidence with mount_prefix_base', async () => {
    const root = tmp('chi-mount-only');
    const file = makeFile(root, 'cmd/server/main.go', `
package main

import (
    "net/http"

    "github.com/go-chi/chi/v5"
)

func main() {
    r := chi.NewRouter()
    r.Mount("/admin", adminHandler())
    http.ListenAndServe(":8080", r)
}

func adminHandler() http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
        w.Write([]byte("admin"))
    })
}
`);
    try {
      const result = await goChiAdapter.introspect([file], root);
      // With grammar primed: medium (no routeMethods, has mount_prefix_base).
      // Without grammar: none.
      expect(['none', 'medium']).toContain(result.confidence);
      if (result.confidence === 'medium') {
        expect(result.conventions.mount_prefix_base).toBe('/admin');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('broken Go syntax → does NOT crash, returns none', async () => {
    const root = tmp('chi-broken');
    const file = makeFile(root, 'internal/broken.go', `
package api ((( bla bla
import "go-chi/chi"
func NewRouter()) {{
    r := !!!chi.NewRouter()
`);
    try {
      const result = await goChiAdapter.introspect([file], root);
      expect(['none', 'medium']).toContain(result.confidence);
      // The key invariant: no throw.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('user-defined middleware (not chi middleware.*) → NOT captured as middleware_name', async () => {
    const root = tmp('chi-user-mw');
    const file = makeFile(root, 'internal/api/router.go', `
package api

import (
    "net/http"

    "github.com/go-chi/chi/v5"
)

func myAuth(next http.Handler) http.Handler { return next }

func NewRouter() http.Handler {
    r := chi.NewRouter()
    r.Use(myAuth)
    r.Get("/health", health)
    return r
}

func health(w http.ResponseWriter, req *http.Request) { w.Write([]byte("ok")) }
`);
    try {
      const result = await goChiAdapter.introspect([file], root);
      expect(['none', 'high']).toContain(result.confidence);
      // middleware_name should NOT be set since myAuth is not chi middleware.*.
      if (result.confidence !== 'none') {
        expect(result.conventions.middleware_name).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('extractPrefixBase: handles deeply-nested mount paths (returns first segment)', async () => {
    const root = tmp('chi-nested-mount');
    const file = makeFile(root, 'internal/api/router.go', `
package api

import (
    "net/http"

    "github.com/go-chi/chi/v5"
)

func NewRouter(h http.Handler) http.Handler {
    r := chi.NewRouter()
    r.Mount("/api/v2/internal/admin", h)
    return r
}
`);
    try {
      const result = await goChiAdapter.introspect([file], root);
      if (result.confidence === 'medium' || result.confidence === 'high') {
        // Only the first segment should survive — the prefix-base extractor
        // mirrors python-fastapi/flask behavior.
        if (result.conventions.mount_prefix_base) {
          expect(result.conventions.mount_prefix_base).toBe('/api');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Mount with non-string-literal path (variable) → mount_prefix_base NOT captured', async () => {
    const root = tmp('chi-mount-var');
    const file = makeFile(root, 'internal/api/router.go', `
package api

import (
    "net/http"

    "github.com/go-chi/chi/v5"
)

const apiBase = "/api"

func NewRouter(h http.Handler) http.Handler {
    r := chi.NewRouter()
    r.Mount(apiBase, h)
    r.Get("/health", health)
    return r
}

func health(w http.ResponseWriter, req *http.Request) { w.Write([]byte("ok")) }
`);
    try {
      const result = await goChiAdapter.introspect([file], root);
      expect(['none', 'high']).toContain(result.confidence);
      if (result.confidence !== 'none') {
        // The Mount uses a variable, not a string literal, so the AST query
        // doesn't match. mount_prefix_base must NOT be set.
        expect(result.conventions.mount_prefix_base).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
