---
name: massu-scaffold-page
description: "When user wants to create a new view, screen, or page in a SwiftUI iOS / visionOS app — scaffolds the View, ViewModel, and Decodable response model with project conventions"
allowed-tools: Bash(*), Read(*), Write(*), Edit(*), Grep(*), Glob(*)
---

# Scaffold New SwiftUI View

Creates a SwiftUI View + `@MainActor` ViewModel + Decodable response model. Suitable for iOS, visionOS, or any cross-platform SwiftUI target.

## What Gets Created

| File | Purpose |
|------|---------|
| `${paths.swift_source}/Features/<feature>/Views/<Name>View.swift` | SwiftUI view |
| `${paths.swift_source}/Features/<feature>/ViewModels/<Name>ViewModel.swift` | `@MainActor` ObservableObject |
| `${paths.swift_source}/Features/<feature>/Models/<Name>Response.swift` | Decodable matching API contract |

> **Path resolution**: substitute `${paths.swift_source}` against your project's `massu.config.yaml` (`paths.swift_source`). If unset, fall back to whatever the project already uses (`Sources/`, `apps/ios/<App>/<App>/`, etc.).

## Template — `<Name>View.swift`

```swift
import SwiftUI

struct <Name>View: View {
    @StateObject private var viewModel = <Name>ViewModel()

    var body: some View {
        Group {
            if viewModel.isLoading {
                ProgressView()
            } else if let error = viewModel.error {
                ErrorState(message: error) { Task { await viewModel.load() } }
            } else {
                content
            }
        }
        .task { await viewModel.load() }
        .navigationTitle("<Title>")
    }

    private var content: some View {
        // Build the real view here
        EmptyView()
    }
}
```

## Template — `<Name>ViewModel.swift`

```swift
import Foundation

@MainActor
final class <Name>ViewModel: ObservableObject {
    @Published var data: <Name>Response?
    @Published var isLoading = false
    @Published var error: String?

    // Substitute APIClient with the project's actual API wrapper.
    private let api: APIClient

    init(api: APIClient = .shared) {
        self.api = api
    }

    func load() async {
        isLoading = true
        error = nil
        defer { isLoading = false }
        do {
            data = try await api.get("/api/<endpoint>", as: <Name>Response.self)
        } catch {
            self.error = humanReadableError(error)
        }
    }
}
```

## Template — `<Name>Response.swift`

```swift
import Foundation

struct <Name>Response: Decodable {
    // IMPORTANT: properties MUST be camelCase versions of the snake_case API keys.
    // The decoder typically uses .convertFromSnakeCase, but mismatches decode to
    // nil silently — verify property names against an actual API response.
    let symbol: String
    let priceUsd: Double         // matches "price_usd"
    let updatedAt: Date          // matches "updated_at"
}
```

## SwiftUI Conventions (apply in any project)

- **Decodable silent nil**: with `JSONDecoder.keyDecodingStrategy = .convertFromSnakeCase`, a typo'd property decodes to nil with NO error. Hand-verify every property against a real API response — entire screens have shipped showing dead data because of this.
- **`.system(size:weight:design:)` argument order**: weight before design. Reversed args silently fall back to default font.
- **Biometric authentication**: for sensitive actions, use `LAPolicy.deviceOwnerAuthenticationWithBiometrics` — NOT `deviceOwnerAuthentication` (which falls back to a passcode and defeats the gate).
- **Sheet state**: never clear `@State` sheet-bound vars in async callbacks; use `.onDismiss` instead.
- **XcodeGen target naming**: cross-platform projects often split iOS / visionOS into separate targets (e.g., `<App>_iOS` / `<App>_visionOS`). Build the platform-specific scheme, NOT the umbrella name.
- **`@MainActor` on view models**: any `@Published` field that drives UI must be set on the main actor. Async work updates state via `await MainActor.run { ... }` if the function isn't already main-actor-isolated.

## Process

1. Ask: which feature folder? Which target (iOS / visionOS / both)?
2. Read the API endpoint's actual JSON response (e.g., `curl -sS http://<service>/api/<endpoint> | python3 -m json.tool`) — copy the EXACT key names so the Decodable can't drift.
3. Write the three files.
4. Add the new files to your project's manifest (`project.yml` for XcodeGen, or directly in Xcode for hand-managed projects); regen if needed: `cd ${paths.swift_source}/.. && xcodegen`.
5. Build the right scheme:
   ```bash
   cd ${paths.swift_source}/.. && xcodebuild -scheme <Target>_iOS -destination 'generic/platform=iOS Simulator' build | tail -20
   ```

## START NOW

Ask the user:
1. Which feature folder, and which target (iOS / visionOS / both)?
2. What does the screen show, and which API endpoint feeds it?
3. Does it perform any sensitive action (purchase, trade, settings change)? — if yes, the project's biometric gate is required.
