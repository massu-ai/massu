/**
 * Tests for the three-class adapter trust model (Plan 3c gap-47 + gap-48 + gap-50).
 *
 * Coverage:
 * - CORE-BUNDLED: id matches the coreBundledIds set, no npmPackage, no configLocalPaths
 * - REGISTRY-VERIFIED: npmPackage with @massu/adapter-* name, or massuAdapter:true
 * - LOCAL-EXPLICIT: id matches a configLocalPaths entry
 * - Multi-class collision returns null (refuse to load)
 * - Zero-class match returns null (refuse to load)
 * - @massu-org-published packages MUST still match REGISTRY-VERIFIED (gap-48 — being
 *   `@massu`-published does NOT exempt them from manifest signing; only CORE-BUNDLED does)
 */
import { describe, it, expect } from 'vitest';
import { getAdapterOrigin } from '../security/adapter-origin.js';

const CORE_IDS = new Set(['python-fastapi', 'python-django', 'nextjs-trpc', 'swift-swiftui']);

describe('getAdapterOrigin', () => {
  describe('CORE-BUNDLED', () => {
    it('classifies an id present in coreBundledIds as core-bundled', () => {
      const result = getAdapterOrigin({
        id: 'python-fastapi',
        coreBundledIds: CORE_IDS,
      });
      expect(result).toBe('core-bundled');
    });

    it('does NOT classify a kebab-case id absent from coreBundledIds', () => {
      const result = getAdapterOrigin({
        id: 'unknown-framework',
        coreBundledIds: CORE_IDS,
      });
      expect(result).toBeNull();
    });
  });

  describe('REGISTRY-VERIFIED', () => {
    it('classifies an @massu/adapter-* package as registry-verified', () => {
      const result = getAdapterOrigin({
        id: '@massu/adapter-rails',
        coreBundledIds: CORE_IDS,
        npmPackage: { name: '@massu/adapter-rails', version: '0.1.0', massuAdapter: true },
      });
      expect(result).toBe('registry-verified');
    });

    it('classifies a third-party package with massuAdapter:true as registry-verified', () => {
      const result = getAdapterOrigin({
        id: 'community-adapter-foo',
        coreBundledIds: CORE_IDS,
        npmPackage: { name: 'community-adapter-foo', version: '1.0.0', massuAdapter: true },
      });
      expect(result).toBe('registry-verified');
    });

    it('does NOT classify an @massu/* package without adapter- prefix', () => {
      const result = getAdapterOrigin({
        id: '@massu/core',
        coreBundledIds: CORE_IDS,
        npmPackage: { name: '@massu/core', version: '1.4.0', massuAdapter: false },
      });
      expect(result).toBeNull();
    });

    it('does NOT classify a package without the massu-adapter declaration AND without @massu/adapter-* name', () => {
      const result = getAdapterOrigin({
        id: 'random-package',
        coreBundledIds: CORE_IDS,
        npmPackage: { name: 'random-package', version: '1.0.0', massuAdapter: false },
      });
      expect(result).toBeNull();
    });
  });

  describe('LOCAL-EXPLICIT', () => {
    it('classifies a path present in configLocalPaths as local-explicit', () => {
      const result = getAdapterOrigin({
        id: 'adapters/my-custom.js',
        coreBundledIds: CORE_IDS,
        configLocalPaths: new Set(['adapters/my-custom.js']),
      });
      expect(result).toBe('local-explicit');
    });

    it('does NOT classify a path absent from configLocalPaths', () => {
      const result = getAdapterOrigin({
        id: 'adapters/not-listed.js',
        coreBundledIds: CORE_IDS,
        configLocalPaths: new Set(['adapters/some-other.js']),
      });
      expect(result).toBeNull();
    });
  });

  describe('collision and unclassified', () => {
    it('returns null when an id matches multiple classes (collision)', () => {
      // Synthetic: an id that simultaneously appears in coreBundledIds AND
      // configLocalPaths. In practice this should not happen because CORE-BUNDLED
      // ids are kebab-case framework names while LOCAL-EXPLICIT ids are file paths,
      // but the loader must refuse the ambiguous case anyway.
      const result = getAdapterOrigin({
        id: 'python-fastapi',
        coreBundledIds: CORE_IDS,
        configLocalPaths: new Set(['python-fastapi']),
      });
      expect(result).toBeNull();
    });

    it('returns null for an unclassified id', () => {
      const result = getAdapterOrigin({
        id: 'orphan-id',
        coreBundledIds: CORE_IDS,
      });
      expect(result).toBeNull();
    });
  });

  describe('gap-48 explicit verification — @massu-org packages still REGISTRY-VERIFIED', () => {
    it('@massu/adapter-rails is REGISTRY-VERIFIED, NOT core-bundled', () => {
      const result = getAdapterOrigin({
        id: '@massu/adapter-rails',
        coreBundledIds: CORE_IDS,
        npmPackage: { name: '@massu/adapter-rails', version: '0.1.0', massuAdapter: true },
      });
      // The @massu org alone does NOT exempt from manifest signing; same trust path
      // as a community contribution per the three-class model.
      expect(result).toBe('registry-verified');
      expect(result).not.toBe('core-bundled');
    });
  });
});
