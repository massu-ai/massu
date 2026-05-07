/**
 * Three-class adapter trust model (Plan 3c gap-47 + gap-48 + gap-50 deliverable).
 *
 * Every adapter that the loader is asked to load MUST classify into exactly
 * ONE of the three classes below. The verifier dispatches per origin; an
 * adapter that classifies into ZERO classes (or matches multiple) is REFUSED
 * to load with a clear stderr message.
 *
 * The three classes:
 *
 * 1. CORE-BUNDLED — adapters that ship inside @massu/core itself at
 *    packages/core/src/detect/adapters/*.ts. Trust derives from @massu/core's
 *    own npm publish (provenance attestations) + the prepublish-check.sh
 *    audit + the user's explicit `npm install @massu/core` choice. These
 *    adapters do NOT appear in manifest.json (they have no package, no
 *    separate version, no separate tarball). Loader skips signature
 *    verification AND emits no warning — this is the trusted baseline.
 *    Plan 3b shipped 4 (FastAPI, Django, tRPC, SwiftUI); Phase 7 ships 31
 *    more (35 total).
 *
 * 2. REGISTRY-VERIFIED — third-party npm packages that EITHER match
 *    `@massu/adapter-*` glob OR declare `"massu-adapter": true` in their
 *    package.json. Trust derives from the manifest.json allowlist + per-
 *    package sha256 + Ed25519 manifest signature. The 5 first-shipped
 *    `@massu`-org packages (rails, phoenix, aspnet, spring, go-chi) live
 *    in this class — being `@massu`-org-published does NOT exempt them
 *    from manifest signing (gap-48 named-resolution).
 *
 * 3. LOCAL-EXPLICIT — TypeScript / JavaScript files listed by the user in
 *    `massu.config.yaml > adapters.local`. Trust derives from the user's
 *    explicit per-path entry + the postinstall-poisoning fingerprint check
 *    (gap-32 / gap-58). Loader emits a one-time stderr note per startup
 *    naming the loaded local path.
 *
 * Concretely, getAdapterOrigin() returns the union type below. Anything
 * that doesn't match exactly one class is the unclassified branch — the
 * verifier MUST refuse to load.
 */

export type AdapterOrigin = 'core-bundled' | 'registry-verified' | 'local-explicit';

export interface AdapterDescriptor {
  /**
   * Stable identifier the loader uses to address this adapter. For
   * CORE-BUNDLED: the filename without `.ts` (e.g. `python-fastapi`).
   * For REGISTRY-VERIFIED: the npm package name (e.g. `@massu/adapter-rails`).
   * For LOCAL-EXPLICIT: the POSIX-normalized path from `adapters.local`.
   */
  id: string;
  origin: AdapterOrigin;
  /**
   * For REGISTRY-VERIFIED only: package version (semver). Undefined for
   * CORE-BUNDLED (which inherits @massu/core's version) and LOCAL-EXPLICIT
   * (which has no semver — local files don't publish).
   */
  version?: string;
  /**
   * For REGISTRY-VERIFIED only: absolute path to the package directory in
   * node_modules (or wherever the discovery scan found it). Used to compute
   * the load-time sha256 (gap-37 install-time + load-time verification).
   * Undefined for CORE-BUNDLED (resolved inside the @massu/core bundle) and
   * LOCAL-EXPLICIT (use the path from adapters.local directly).
   */
  packageDir?: string;
}

export interface AdapterOriginInput {
  /** The id under inspection. */
  id: string;
  /**
   * Set of adapter ids that ship CORE-BUNDLED in @massu/core itself. The
   * loader produces this set via `import.meta.glob`-style scan of
   * packages/core/src/detect/adapters/*.ts. Pass ['python-fastapi',
   * 'python-django', 'nextjs-trpc', 'swift-swiftui'] today; Phase 7 grows
   * this to 35 entries.
   */
  coreBundledIds: ReadonlySet<string>;
  /**
   * Optional: the npm package metadata (when id matches a discovered
   * node_modules package). When present + `id` matches an `@massu/adapter-*`
   * pattern OR `massuAdapter === true`, this is REGISTRY-VERIFIED.
   */
  npmPackage?: {
    name: string;
    version: string;
    massuAdapter: boolean;
  };
  /**
   * Optional: set of POSIX-normalized adapter paths from
   * `getConfig().adapters?.local ?? []`. When present + id matches one of
   * these entries, this is LOCAL-EXPLICIT.
   */
  configLocalPaths?: ReadonlySet<string>;
}

/**
 * Classify an adapter id into exactly one of the three trust classes, or
 * return null if the id does not match any class. Loader MUST refuse to
 * load null-classified adapters.
 *
 * Multi-class collision (id matches more than one class) is an error
 * condition — caller should treat it as null + emit a clear stderr note
 * naming all the matching classes. This shouldn't happen in practice
 * because CORE-BUNDLED ids are kebab-case framework names while REGISTRY-
 * VERIFIED ids start with `@` (npm scope) and LOCAL-EXPLICIT ids are file
 * paths — they don't intersect under normal config.
 */
export function getAdapterOrigin(input: AdapterOriginInput): AdapterOrigin | null {
  const matches: AdapterOrigin[] = [];

  if (input.coreBundledIds.has(input.id)) {
    matches.push('core-bundled');
  }

  if (input.npmPackage) {
    const isMassuOrgAdapter = /^@massu\/adapter-/.test(input.npmPackage.name);
    const declaresMassuAdapter = input.npmPackage.massuAdapter === true;
    if ((isMassuOrgAdapter || declaresMassuAdapter) && input.npmPackage.name === input.id) {
      matches.push('registry-verified');
    }
  }

  if (input.configLocalPaths && input.configLocalPaths.has(input.id)) {
    matches.push('local-explicit');
  }

  // Exactly one match → that class. Zero or multiple → unclassified (refuse).
  if (matches.length === 1) return matches[0]!;
  return null;
}
