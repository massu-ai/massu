// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectPackageManifests } from '../detect/package-detector.ts';

describe('detect/package-detector', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-pkg-det-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses package.json with TS detection', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.2.3',
        dependencies: { react: '^18.0.0', next: '^14.0.0' },
        devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
        scripts: { test: 'vitest', build: 'next build' },
      })
    );
    const { manifests, warnings } = detectPackageManifests(root);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].language).toBe('typescript');
    expect(manifests[0].name).toBe('demo');
    expect(manifests[0].version).toBe('1.2.3');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['react', 'next'])
    );
    expect(manifests[0].devDependencies).toEqual(
      expect.arrayContaining(['typescript', 'vitest'])
    );
    expect(manifests[0].scripts).toEqual(['test', 'build']);
    expect(warnings).toHaveLength(0);
  });

  it('parses pyproject.toml (PEP 621 style)', () => {
    writeFileSync(
      join(root, 'pyproject.toml'),
      `[project]
name = "svc"
version = "0.1.0"
dependencies = ["fastapi>=0.110", "sqlalchemy[asyncio]>=2.0", "pydantic"]

[project.optional-dependencies]
test = ["pytest>=8.0", "pytest-asyncio"]
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].language).toBe('python');
    expect(manifests[0].name).toBe('svc');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['fastapi', 'sqlalchemy', 'pydantic'])
    );
    expect(manifests[0].devDependencies).toEqual(
      expect.arrayContaining(['pytest', 'pytest-asyncio'])
    );
  });

  it('parses pyproject.toml (poetry style)', () => {
    writeFileSync(
      join(root, 'pyproject.toml'),
      `[tool.poetry]
name = "poet"
version = "0.2.0"

[tool.poetry.dependencies]
python = "^3.11"
flask = "^3.0"
sqlalchemy = "^2.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests[0].language).toBe('python');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['flask', 'sqlalchemy'])
    );
    expect(manifests[0].dependencies).not.toContain('python');
    expect(manifests[0].devDependencies).toEqual(
      expect.arrayContaining(['pytest'])
    );
  });

  it('parses requirements.txt skipping comments and directives', () => {
    writeFileSync(
      join(root, 'requirements.txt'),
      `# prod deps
fastapi>=0.110
sqlalchemy[asyncio]>=2.0
-r requirements-dev.txt
--index-url https://pypi.org/simple

pydantic
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['fastapi', 'sqlalchemy', 'pydantic'])
    );
    expect(manifests[0].dependencies).not.toContain('-r');
  });

  it('parses Cargo.toml', () => {
    writeFileSync(
      join(root, 'Cargo.toml'),
      `[package]
name = "mycrate"
version = "0.1.0"
edition = "2021"

[dependencies]
actix-web = "4"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
criterion = "0.5"
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].language).toBe('rust');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['actix-web', 'tokio'])
    );
    expect(manifests[0].devDependencies).toEqual(['criterion']);
  });

  it('parses Package.swift and extracts dep names from urls', () => {
    writeFileSync(
      join(root, 'Package.swift'),
      `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MyApp",
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),
        .package(name: "SwiftNIO", url: "https://github.com/apple/swift-nio.git", from: "2.0.0")
    ]
)
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].language).toBe('swift');
    expect(manifests[0].name).toBe('MyApp');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['vapor', 'SwiftNIO'])
    );
  });

  it('parses go.mod', () => {
    writeFileSync(
      join(root, 'go.mod'),
      `module github.com/me/app

go 1.22

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/stretchr/testify v1.8.4
)

require github.com/labstack/echo v4.11.0
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests[0].language).toBe('go');
    expect(manifests[0].name).toBe('github.com/me/app');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining([
        'github.com/gin-gonic/gin',
        'github.com/stretchr/testify',
        'github.com/labstack/echo',
      ])
    );
  });

  it('parses pom.xml dependencies', () => {
    writeFileSync(
      join(root, 'pom.xml'),
      `<?xml version="1.0"?>
<project>
  <artifactId>my-svc</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.2.0</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.0</version>
    </dependency>
  </dependencies>
</project>
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests[0].language).toBe('java');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['spring-boot-starter-web', 'junit-jupiter'])
    );
  });

  it('parses build.gradle implementations', () => {
    writeFileSync(
      join(root, 'build.gradle'),
      `plugins { id 'java' }

dependencies {
  implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'
  testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'
  runtimeOnly("org.postgresql:postgresql:42.7.0")
}
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests[0].language).toBe('java');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['spring-boot-starter-web', 'postgresql'])
    );
    expect(manifests[0].devDependencies).toEqual(['junit-jupiter']);
  });

  it('parses Gemfile', () => {
    writeFileSync(
      join(root, 'Gemfile'),
      `source 'https://rubygems.org'
gem 'rails', '~> 7.1'
gem 'pg'
group :test do
  gem 'rspec'
end
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests[0].language).toBe('ruby');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['rails', 'pg'])
    );
    expect(manifests[0].devDependencies).toEqual(
      expect.arrayContaining(['rspec'])
    );
  });

  it('walks monorepo apps/* and packages/*', () => {
    // Outer
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'outer', private: true, workspaces: ['apps/*', 'packages/*'] })
    );
    // apps/ai-service with pyproject
    mkdirSync(join(root, 'apps', 'ai-service'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'ai-service', 'pyproject.toml'),
      `[project]\nname = "ai"\nversion = "0.1"\ndependencies = ["fastapi"]\n`
    );
    // apps/web with package.json
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'web', 'package.json'),
      JSON.stringify({
        name: 'web',
        dependencies: { next: '^14.0.0' },
        devDependencies: { typescript: '^5' },
      })
    );
    // packages/shared
    mkdirSync(join(root, 'packages', 'shared'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'shared', 'package.json'),
      JSON.stringify({
        name: 'shared',
        dependencies: {},
        devDependencies: { typescript: '^5' },
      })
    );
    const { manifests } = detectPackageManifests(root);
    const names = manifests.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['outer', 'ai', 'web', 'shared']));
    expect(manifests.find((m) => m.name === 'ai')?.language).toBe('python');
    expect(manifests.find((m) => m.name === 'web')?.language).toBe('typescript');
  });

  it('records warning for malformed package.json without throwing', () => {
    writeFileSync(join(root, 'package.json'), '{ not-json');
    const { manifests, warnings } = detectPackageManifests(root);
    expect(manifests).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].reason).toMatch(/package\.json/);
  });

  it('returns empty manifests for empty directory', () => {
    const { manifests, warnings } = detectPackageManifests(root);
    expect(manifests).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('parses Pipfile and attributes dev-packages correctly', () => {
    writeFileSync(
      join(root, 'Pipfile'),
      `[[source]]
url = "https://pypi.org/simple"

[packages]
flask = "*"
sqlalchemy = "*"

[dev-packages]
pytest = "*"
`
    );
    const { manifests } = detectPackageManifests(root);
    expect(manifests[0].language).toBe('python');
    expect(manifests[0].dependencies).toEqual(
      expect.arrayContaining(['flask', 'sqlalchemy'])
    );
    expect(manifests[0].devDependencies).toEqual(['pytest']);
  });

  it('rejects symlinked manifests (security: safeRead uses lstatSync)', () => {
    // Create an external "real" package.json pretending to contain a forged
    // manifest. Then put a symlink in the project root pointing at it.
    const externalDir = mkdtempSync(join(tmpdir(), 'massu-pkg-external-'));
    try {
      const externalManifest = join(externalDir, 'package.json');
      writeFileSync(
        externalManifest,
        JSON.stringify({
          name: 'forged',
          version: '9.9.9',
          dependencies: { 'malicious-dep': '^1.0.0' },
        })
      );
      // Symlink into the project root.
      symlinkSync(externalManifest, join(root, 'package.json'));
      const { manifests, warnings } = detectPackageManifests(root);
      // safeRead must reject the symlinked manifest — no manifests should be parsed.
      expect(manifests).toHaveLength(0);
      // No warnings because existsSync+lstatSync path bails before parse.
      expect(warnings).toHaveLength(0);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });
});
