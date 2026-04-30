import Foundation
import Sentry

enum SentryRuntime {
    private static let lock = NSLock()
    private static var sdkStarted = false

    static func markStarted() {
        lock.lock()
        sdkStarted = true
        lock.unlock()
    }

    static var isStarted: Bool {
        lock.lock()
        let value = sdkStarted
        lock.unlock()
        return value
    }
}

enum SentryPrivacy {
    static let captureDiagnosticEvents = false
    static let maxBreadcrumbs: UInt = 25

    private static let redactedValue = "<redacted>"
    private static let redactedPath = "<redacted-path>"
    private static let redactedURL = "<redacted-url>"
    private static let redactedQuery = "<redacted-query>"
    private static let redactedEmail = "<redacted-email>"
    private static let redactedBytes = "<redacted-bytes>"
    private static let redactedIdentifier = "<redacted-id>"

    private static let pathKeyHints = [
        "path", "file", "directory", "folder", "cwd", "workspace", "project", "repo", "document", "doc"
    ]
    private static let urlKeyHints = ["url", "uri", "link", "href"]
    private static let queryKeyHints = ["query", "fragment"]
    private static let directRedactionKeyHints = ["cookie", "header", "body", "html"]
    private static let identifierKeyHints = ["token", "session", "email", "username", "user", "ip"]

    static func sanitizeBreadcrumb(_ breadcrumb: Breadcrumb) -> Breadcrumb? {
        breadcrumb.message = sanitizeString(breadcrumb.message, key: "message")
        breadcrumb.data = sanitizeDictionary(breadcrumb.data)
        return breadcrumb
    }

    static func sanitizeEvent(_ event: Event) -> Event? {
        event.serverName = nil
        event.transaction = sanitizeString(event.transaction, key: "transaction")
        event.logger = sanitizeString(event.logger, key: "logger")

        if let tags = event.tags {
            event.tags = tags.mapValues { sanitizeString($0, key: nil) ?? $0 }
        }
        event.extra = sanitizeDictionary(event.extra)

        if let context = event.context {
            event.context = context.reduce(into: [String: [String: Any]]()) { partialResult, entry in
                partialResult[entry.key] = sanitizeDictionary(entry.value) ?? [:]
            }
        }

        if let breadcrumbs = event.breadcrumbs {
            event.breadcrumbs = breadcrumbs.compactMap(sanitizeBreadcrumb)
        }

        if let request = event.request {
            request.cookies = nil
            request.headers = nil
            request.queryString = nil
            request.fragment = nil
            request.url = sanitizeURLString(request.url) ?? request.url.map { _ in redactedURL }
        }

        if let user = event.user {
            user.userId = nil
            user.email = nil
            user.username = nil
            user.ipAddress = nil
            user.name = nil
            user.geo = nil
            user.data = nil
        }

        if let exceptions = event.exceptions {
            for exception in exceptions {
                exception.value = sanitizeString(exception.value, key: "exception")
                exception.module = sanitizeString(exception.module, key: "module")
            }
        }

        return event
    }

    static func sanitizeDictionary(_ dictionary: [String: Any]?) -> [String: Any]? {
        guard let dictionary else { return nil }
        return dictionary.reduce(into: [String: Any]()) { partialResult, entry in
            partialResult[entry.key] = sanitizeValue(entry.value, key: entry.key)
        }
    }

    static func sanitizeString(_ value: String?, key: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return value }

        let lowerKey = key?.lowercased() ?? ""
        if matchesAnyHint(lowerKey, hints: directRedactionKeyHints) {
            return redactedValue
        }
        if matchesAnyHint(lowerKey, hints: queryKeyHints) {
            return redactedQuery
        }
        if matchesAnyHint(lowerKey, hints: pathKeyHints) {
            return redactedPath
        }
        if matchesAnyHint(lowerKey, hints: urlKeyHints) {
            return sanitizeURLString(trimmed) ?? redactedURL
        }
        if matchesAnyHint(lowerKey, hints: identifierKeyHints) {
            if lowerKey.contains("email") {
                return redactedEmail
            }
            return redactedIdentifier
        }
        if looksLikeEmail(trimmed) {
            return redactedEmail
        }
        if looksLikeAbsolutePath(trimmed) {
            return redactedPath
        }
        if let sanitizedURL = sanitizeURLString(trimmed) {
            return sanitizedURL
        }
        if looksLikeIdentifier(trimmed) {
            return redactedIdentifier
        }
        if looksLikeQueryString(trimmed) {
            return redactedQuery
        }
        return trimmed
    }

    private static func sanitizeValue(_ value: Any, key: String?) -> Any {
        switch value {
        case let string as String:
            return sanitizeString(string, key: key) ?? string
        case let url as URL:
            return sanitizeURLString(url.absoluteString) ?? redactedURL
        case let dictionary as [String: Any]:
            return sanitizeDictionary(dictionary) ?? [:]
        case let array as [Any]:
            return array.map { sanitizeValue($0, key: key) }
        case is Data:
            return redactedBytes
        default:
            return value
        }
    }

    private static func sanitizeURLString(_ value: String?) -> String? {
        guard let value else { return nil }
        guard let components = URLComponents(string: value) else { return nil }
        if components.scheme == "file" {
            return redactedPath
        }
        guard let scheme = components.scheme else {
            return nil
        }
        if let host = components.host {
            var sanitized = "\(scheme)://\(host)"
            if let port = components.port {
                sanitized += ":\(port)"
            }
            return sanitized
        }
        return redactedURL
    }

    private static func matchesAnyHint(_ key: String, hints: [String]) -> Bool {
        hints.contains { key.contains($0) }
    }

    private static func looksLikeAbsolutePath(_ value: String) -> Bool {
        value.hasPrefix("/") || value.hasPrefix("~") || value.hasPrefix("file://")
    }

    private static func looksLikeEmail(_ value: String) -> Bool {
        guard let at = value.firstIndex(of: "@") else { return false }
        let domainStart = value.index(after: at)
        return domainStart < value.endIndex && value[domainStart...].contains(".")
    }

    private static func looksLikeIdentifier(_ value: String) -> Bool {
        let lowercase = value.lowercased()
        if lowercase.count == 36,
           lowercase.filter({ $0 == "-" }).count == 4,
           lowercase.replacingOccurrences(of: "-", with: "").count == 32 {
            return true
        }
        if lowercase.count >= 24, lowercase.allSatisfy({ $0.isHexDigit }) {
            return true
        }
        return false
    }

    private static func looksLikeQueryString(_ value: String) -> Bool {
        value.contains("=") && (value.contains("&") || value.contains("?"))
    }
}

/// Add a Sentry breadcrumb for user-action context in hang/crash reports.
func sentryBreadcrumb(_ message: String, category: String = "ui", data: [String: Any]? = nil) {
    guard SentrySettings.enabledForCurrentLaunch, SentryRuntime.isStarted else { return }
    let crumb = Breadcrumb(level: .info, category: category)
    crumb.message = message
    crumb.data = SentryPrivacy.sanitizeDictionary(data)
    SentrySDK.addBreadcrumb(crumb)
}

private func sentryCaptureMessage(
    _ message: String,
    level: SentryLevel,
    category: String,
    data: [String: Any]?,
    contextKey: String?
) {
    guard SentrySettings.enabledForCurrentLaunch, SentryRuntime.isStarted, SentryPrivacy.captureDiagnosticEvents else { return }
    _ = SentrySDK.capture(message: message) { scope in
        scope.setLevel(level)
        scope.setTag(value: category, key: "category")
        if let data {
            scope.setContext(value: SentryPrivacy.sanitizeDictionary(data) ?? [:], key: contextKey ?? category)
        }
    }
}

func sentryCaptureWarning(
    _ message: String,
    category: String = "ui",
    data: [String: Any]? = nil,
    contextKey: String? = nil
) {
    sentryCaptureMessage(message, level: .warning, category: category, data: data, contextKey: contextKey)
}

func sentryCaptureError(
    _ message: String,
    category: String = "ui",
    data: [String: Any]? = nil,
    contextKey: String? = nil
) {
    sentryCaptureMessage(message, level: .error, category: category, data: data, contextKey: contextKey)
}
