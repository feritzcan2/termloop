# TermLoop Hook Patterns

Any edit inside an upstream file must follow the hook pattern.

## Marker format

```swift
// MARK: termloop-hook
TermLoopHooks.workspaceDidCreate(workspace)
// MARK: /termloop-hook
```

Every hook call is wrapped in an opening `// MARK: termloop-hook` and closing
`// MARK: /termloop-hook`. Marker counts must balance.

## Four permitted hook types

### 1. Lifecycle hook

Called at the end of an upstream event/callback. Implementation lives in
`TermLoopHooks` namespace.

```swift
// Upstream AppDelegate.swift
func applicationDidFinishLaunching(_ notification: Notification) {
    // ... upstream code ...

    // MARK: termloop-hook
    TermLoopHooks.appDidFinishLaunching()
    // MARK: /termloop-hook
}
```

### 2. Extension property

Pseudo-property on an upstream class. Lives in `Sources/TermLoop/Hooks/`.

```swift
// Sources/TermLoop/Hooks/Workspace+TermLoop.swift
extension Workspace {
    var projectId: UUID? {
        WorkspaceMetadataStore.shared.metadata(for: self).projectId
    }
}
```

### 3. Extension method

New method on an upstream class, in `Sources/TermLoop/Hooks/`.

```swift
// Sources/TermLoop/Hooks/TabManager+TermLoop.swift
extension TabManager {
    func addWorkspaceWithProjectId(_ projectId: UUID?) -> Workspace {
        let ws = addWorkspace()
        WorkspaceMetadataStore.shared.setProjectId(projectId, for: ws)
        return ws
    }
}
```

### 4. UI injection point

SwiftUI subview inserted into an upstream view via a single line.

```swift
// Upstream ContentView.swift
VStack {
    // ... upstream sidebar elements ...

    // MARK: termloop-hook
    TermLoopSidebarInjection(state: sidebarState)
    // MARK: /termloop-hook
}
```

## The `TermLoopHooks` namespace

All lifecycle hook implementations live in `Sources/TermLoop/Core/TermLoopHooks.swift`:

```swift
@MainActor
enum TermLoopHooks {
    static func appDidFinishLaunching() { /* ... */ }
    static func workspaceDidCreate(_ workspace: Workspace) { /* ... */ }
    static func workspaceWillDelete(_ workspace: Workspace) { /* ... */ }
    static func saveSidecarSnapshot(alongside sessionURL: URL) { /* ... */ }
    static func loadSidecarSnapshot(alongside sessionURL: URL) { /* ... */ }
}
```

Upstream files never see custom implementation — only delegation via `TermLoopHooks.xxx()`.
