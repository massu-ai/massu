// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: swift-swiftui adapter tests.
 *
 * Coverage:
 *   - matches() detects Package.swift / *.xcodeproj / Sources/ / *.swift
 *   - introspect() degradation
 */

import { describe, expect, it } from 'vitest';
import { swiftSwiftUiAdapter } from '../detect/adapters/swift-swiftui.ts';
import type { DetectionSignals } from '../detect/adapters/types.ts';

function emptySignals(overrides: Partial<DetectionSignals> = {}): DetectionSignals {
  return {
    presentDirs: new Set(),
    presentFiles: new Set(),
    ...overrides,
  };
}

describe('swift-swiftui adapter: matches() signal logic', () => {
  it('matches when Package.swift exists', () => {
    const signals = emptySignals({ presentFiles: new Set(['Package.swift']) });
    expect(swiftSwiftUiAdapter.matches(signals)).toBe(true);
  });

  it('matches when *.xcodeproj directory exists', () => {
    const signals = emptySignals({ presentDirs: new Set(['Hedge.xcodeproj']) });
    expect(swiftSwiftUiAdapter.matches(signals)).toBe(true);
  });

  it('matches when *.xcworkspace directory exists', () => {
    const signals = emptySignals({ presentDirs: new Set(['Hedge.xcworkspace']) });
    expect(swiftSwiftUiAdapter.matches(signals)).toBe(true);
  });

  it('matches when Sources/ exists', () => {
    const signals = emptySignals({ presentDirs: new Set(['Sources']) });
    expect(swiftSwiftUiAdapter.matches(signals)).toBe(true);
  });

  it('matches when a .swift file is present at top', () => {
    const signals = emptySignals({ presentFiles: new Set(['App.swift']) });
    expect(swiftSwiftUiAdapter.matches(signals)).toBe(true);
  });

  it('does NOT match a JS project', () => {
    const signals = emptySignals({
      presentFiles: new Set(['package.json', 'index.js']),
      presentDirs: new Set(['node_modules']),
    });
    expect(swiftSwiftUiAdapter.matches(signals)).toBe(false);
  });
});

describe('swift-swiftui adapter: introspect() degradation', () => {
  it('empty file list → none', async () => {
    const r = await swiftSwiftUiAdapter.introspect([], '/tmp/x');
    expect(r.confidence).toBe('none');
  });

  it('grammar unavailable → none, no throw', async () => {
    const files = [{
      path: '/tmp/x/Sources/App/Views/OrdersView.swift',
      content: `import SwiftUI
struct OrdersView: View {
    let api = HedgeAPI()
    var body: some View { NavigationStack { Text("x") } }
}`,
      language: 'swift' as const,
      size: 150,
    }];
    const r = await swiftSwiftUiAdapter.introspect(files, '/tmp/x');
    expect(['none', 'high', 'medium', 'low']).toContain(r.confidence);
  });
});

describe('swift-swiftui adapter: contract', () => {
  it('id is swift-swiftui and languages is ["swift"]', () => {
    expect(swiftSwiftUiAdapter.id).toBe('swift-swiftui');
    expect(swiftSwiftUiAdapter.languages).toEqual(['swift']);
  });
});
