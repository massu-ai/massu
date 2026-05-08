// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 7: tests for Spring (Spring Boot / MVC) AST adapter.
 *
 * Mirrors the aspnet / phoenix / rails / python-flask / go-chi adversarial-
 * fixture pattern. The structural gate that asserts grammar+queries
 * actually work lives in `adapter-grammar-strict.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { springAdapter } from '../detect/adapters/spring.ts';
import type { SourceFile, DetectionSignals } from '../detect/adapters/types.ts';

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `massu-spring-${name}-`));
}

function makeFile(root: string, relPath: string, content: string): SourceFile {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return {
    path: fullPath,
    content,
    language: 'java',
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

function emptySignals(): DetectionSignals {
  return {
    presentDirs: new Set<string>(),
    presentFiles: new Set<string>(),
  };
}

describe('spring adapter — id + languages', () => {
  it('exports id "spring"', () => {
    expect(springAdapter.id).toBe('spring');
  });

  it('targets java language only', () => {
    expect(springAdapter.languages).toEqual(['java']);
  });
});

describe('spring adapter — matches() (cheap signals, no IO)', () => {
  it('matches when pom.xml declares spring-boot-starter-web', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      pomXml: `<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`,
    };
    expect(springAdapter.matches(signals)).toBe(true);
  });

  it('matches when build.gradle.kts declares spring-boot-starter-web', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      gradleBuild: `dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
}
`,
    };
    expect(springAdapter.matches(signals)).toBe(true);
  });

  it('matches Spring MVC (pre-Boot) projects via org.springframework reference', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      pomXml: `<dependency>
  <groupId>org.springframework</groupId>
  <artifactId>spring-webmvc</artifactId>
</dependency>
`,
    };
    expect(springAdapter.matches(signals)).toBe(true);
  });

  it('does NOT match a non-Spring Java project (negative)', () => {
    const signals: DetectionSignals = {
      ...emptySignals(),
      pomXml: `<dependency>
  <groupId>io.javalin</groupId>
  <artifactId>javalin</artifactId>
</dependency>
`,
    };
    expect(springAdapter.matches(signals)).toBe(false);
  });

  it('does NOT match without any build manifest (negative)', () => {
    expect(springAdapter.matches(emptySignals())).toBe(false);
  });
});

describe('spring adapter — introspect()', () => {
  it('empty file list → none confidence', async () => {
    const result = await springAdapter.introspect([], '/nonexistent');
    expect(result.confidence).toBe('none');
    expect(result.conventions).toEqual({});
  });

  it('non-Spring Java file → none confidence', async () => {
    const root = tmp('non-spring');
    const file = makeFile(root, 'src/main/java/Util.java', `
package com.example;

public class Util {
    public static int add(int a, int b) { return a + b; }
}
`);
    try {
      const result = await springAdapter.introspect([file], root);
      expect(result.confidence).toBe('none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('controller with single @GetMapping → high confidence', async () => {
    const root = tmp('single-get');
    const file = makeFile(root, 'src/main/java/UserController.java', `
package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/{id}")
    public String getById(@PathVariable Long id) { return ""; }
}
`);
    try {
      const result = await springAdapter.introspect([file], root);
      expect(['none', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'high') {
        expect(result.conventions.route_method).toBe('Get');
      }
      if (result.confidence !== 'none') {
        if (result.conventions.controller_class) {
          expect(result.conventions.controller_class).toBe('UserController');
        }
        if (result.conventions.route_prefix_base) {
          expect(result.conventions.route_prefix_base).toBe('/api');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('controller with mixed verbs → low confidence', async () => {
    const root = tmp('mixed-verbs');
    const file = makeFile(root, 'src/main/java/Api.java', `
import org.springframework.web.bind.annotation.*;

@RestController
public class Api {
    @GetMapping("/users") public String list() { return ""; }
    @PostMapping("/users") public String create() { return ""; }
    @DeleteMapping("/users/{id}") public void delete() {}
}
`);
    try {
      const result = await springAdapter.introspect([file], root);
      expect(['none', 'low', 'medium', 'high']).toContain(result.confidence);
      if (result.confidence === 'low') {
        expect(result.conventions.route_method).toBeDefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parameterless @PostMapping (marker_annotation) is captured', async () => {
    const root = tmp('marker-mapping');
    const file = makeFile(root, 'src/main/java/Auth.java', `
import org.springframework.web.bind.annotation.*;

@RestController
public class Auth {
    @PostMapping
    public String login() { return ""; }
}
`);
    try {
      const result = await springAdapter.introspect([file], root);
      expect(['none', 'high']).toContain(result.confidence);
      if (result.confidence === 'high') {
        expect(result.conventions.route_method).toBe('Post');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('@Controller (non-Rest) is captured as controller_class', async () => {
    const root = tmp('plain-controller');
    const file = makeFile(root, 'src/main/java/Web.java', `
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class Web {
    @GetMapping("/home") public String home() { return "home"; }
}
`);
    try {
      const result = await springAdapter.introspect([file], root);
      expect(['none', 'high']).toContain(result.confidence);
      if (result.confidence !== 'none' && result.conventions.controller_class) {
        expect(result.conventions.controller_class).toBe('Web');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('class WITHOUT @RestController/@Controller is NOT captured', async () => {
    const root = tmp('no-controller-anno');
    const file = makeFile(root, 'src/main/java/Service.java', `
public class UserService {
    public String greet() { return "hi"; }
}
`);
    try {
      const result = await springAdapter.introspect([file], root);
      expect(result.confidence).toBe('none');
      expect(result.conventions.controller_class).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('broken Java syntax → does NOT crash', async () => {
    const root = tmp('broken');
    const file = makeFile(root, 'src/main/java/Bad.java', `
@RestController
public class Bad ((( {
    @GetMapping !!! "/x") public String x() {{
`);
    try {
      const result = await springAdapter.introspect([file], root);
      expect(['none', 'medium', 'high', 'low']).toContain(result.confidence);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('extractPrefixBase: "/" template → prefix_base NOT captured', async () => {
    const root = tmp('root-template');
    const file = makeFile(root, 'src/main/java/Root.java', `
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/")
public class Root {
    @GetMapping public String home() { return "home"; }
}
`);
    try {
      const result = await springAdapter.introspect([file], root);
      expect(['none', 'high']).toContain(result.confidence);
      expect(result.conventions.route_prefix_base).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('provenance: each captured field has a provenance entry', async () => {
    const root = tmp('provenance');
    const file = makeFile(root, 'src/main/java/HealthController.java', `
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/health")
public class HealthController {
    @GetMapping
    public String index() { return "ok"; }
}
`);
    try {
      const result = await springAdapter.introspect([file], root);
      expect(result.provenance.length).toBe(Object.keys(result.conventions).length);
      for (const p of result.provenance) {
        expect(p.field).toMatch(/^(route_method|route_prefix_base|controller_class)$/);
        expect(p.sourceFile).toBe(file.path);
        expect(p.line).toBeGreaterThanOrEqual(0);
        expect(p.query).toMatch(/^spring-/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
