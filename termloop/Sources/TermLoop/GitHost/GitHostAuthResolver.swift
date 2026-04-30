// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Foundation
import os
#if canImport(Security)
import Security
#endif

struct GitHostAuthorization: Equatable, Sendable {
    enum Source: String, Equatable, Sendable {
        case environment
        case ghCLI
        case gitCredential
        case azureCLI
        case glabCLI
        case personalAccessToken
    }

    /// Headers to set on outbound API requests. All current hosts populate a
    /// single `Authorization` entry (GitHub/GitLab Bearer, Azure Basic). The
    /// dict shape stays so future hosts that need non-`Authorization` headers
    /// can plug in without changing the provider call sites.
    let headers: [String: String]
    let source: Source
    let expiresAt: Date?

    init(headers: [String: String], source: Source, expiresAt: Date?) {
        self.headers = headers
        self.source = source
        self.expiresAt = expiresAt
    }

    /// Convenience for hosts whose auth is a single `Authorization` header.
    init(authorizationHeader: String, source: Source, expiresAt: Date?) {
        self.init(headers: ["Authorization": authorizationHeader], source: source, expiresAt: expiresAt)
    }

    /// Back-compat shim for legacy call sites that read the single
    /// `Authorization` header as a string. New callers should iterate
    /// `headers` or use `apply(to:)`.
    var headerValue: String? { headers["Authorization"] }

    func apply(to request: inout URLRequest) {
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
    }
}

/// Silent auth ladder for hosted git APIs. This never opens a browser or an
/// interactive login prompt; UI can offer explicit sign-in/PAT flows when this
/// resolver returns nil.
enum GitHostAuthResolver {
#if DEBUG
    private static let logger = Logger(subsystem: "com.termloop.git", category: "auth")
#endif

    private struct CacheKey: Hashable {
        let host: GitHostKind
        let scope: String
    }

    nonisolated(unsafe) private static var cache: [CacheKey: GitHostAuthorization] = [:]
    private static let lock = NSLock()
    private static let cacheTTL: TimeInterval = 300
    private static let azureDevOpsResource = "499b84ac-1321-427f-aa17-267ca6975798"

    static func authorization(for identity: GitRemoteIdentity) -> GitHostAuthorization? {
        let key = cacheKey(for: identity)
        let now = Date()
        lock.lock()
        if let cached = cache[key], cached.expiresAt ?? now.addingTimeInterval(cacheTTL) > now {
            lock.unlock()
#if DEBUG
            logger.debug("auth.cacheHit host=\(key.host.rawValue, privacy: .public) scope=\(key.scope, privacy: .public) source=\(cached.source.rawValue, privacy: .public)")
#endif
            return cached
        }
        lock.unlock()

        let authorization: GitHostAuthorization?
        switch identity.host {
        case .github, .githubEnterprise:
            authorization = githubAuthorization(identity: identity)
        case .azureDevOps:
            authorization = azureDevOpsAuthorization(identity: identity)
        case .gitLab:
            authorization = gitLabAuthorization(identity: identity)
        case .unknown:
            authorization = nil
        }

        if let authorization {
            lock.lock()
            cache[key] = authorization
            lock.unlock()
#if DEBUG
            logger.debug("auth.resolved host=\(key.host.rawValue, privacy: .public) scope=\(key.scope, privacy: .public) source=\(authorization.source.rawValue, privacy: .public)")
#endif
        } else {
#if DEBUG
            logger.debug("auth.unavailable host=\(key.host.rawValue, privacy: .public) scope=\(key.scope, privacy: .public)")
#endif
        }
        return authorization
    }

    static func resetCache() {
        lock.lock()
        cache.removeAll()
        lock.unlock()
    }

    private static func githubAuthorization(identity: GitRemoteIdentity) -> GitHostAuthorization? {
        let env = ProcessInfo.processInfo.environment
        if let token = trimmed(env["GH_TOKEN"] ?? env["GITHUB_TOKEN"]), !token.isEmpty {
#if DEBUG
            logger.debug("auth.github.env host=\((identity.github?.host ?? identity.webURL?.host ?? "github.com"), privacy: .public)")
#endif
            return GitHostAuthorization(
                authorizationHeader: "Bearer \(token)",
                source: .environment,
                expiresAt: Date().addingTimeInterval(cacheTTL)
            )
        }

        let host = identity.github?.host ?? identity.webURL?.host ?? "github.com"
        let args: [String]
        if host == "github.com" {
            args = ["auth", "token"]
        } else {
            args = ["auth", "token", "--hostname", host]
        }
        if let token = runCommand(
            executableCandidates: ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"],
            arguments: args,
            timeout: 5,
            environment: [:]
        ), !token.isEmpty {
#if DEBUG
            logger.debug("auth.github.ghCLI host=\(host, privacy: .public)")
#endif
            return GitHostAuthorization(
                authorizationHeader: "Bearer \(token)",
                source: .ghCLI,
                expiresAt: Date().addingTimeInterval(cacheTTL)
            )
        }
        return nil
    }

    private static func azureDevOpsAuthorization(identity: GitRemoteIdentity) -> GitHostAuthorization? {
        let env = ProcessInfo.processInfo.environment
        if let token = trimmed(env["AZURE_DEVOPS_EXT_PAT"] ?? env["AZDO_PAT"] ?? env["ADO_PAT"]), !token.isEmpty {
#if DEBUG
            logger.debug("auth.azure.env org=\(identity.azureDevOps?.organization ?? "unknown", privacy: .public)")
#endif
            return GitHostAuthorization(
                authorizationHeader: basicAuth(username: "termloop", password: token),
                source: .personalAccessToken,
                expiresAt: Date().addingTimeInterval(cacheTTL)
            )
        }

        if let azure = identity.azureDevOps,
           let token = GitHostPATStore.loadToken(host: .azureDevOps, scope: azure.organization) {
#if DEBUG
            logger.debug("auth.azure.keychain org=\(azure.organization, privacy: .public)")
#endif
            return GitHostAuthorization(
                authorizationHeader: basicAuth(username: "termloop", password: token),
                source: .personalAccessToken,
                expiresAt: Date().addingTimeInterval(cacheTTL)
            )
        }

        if let credential = gitCredentialAuthorization(identity: identity) {
#if DEBUG
            logger.debug("auth.azure.gitCredential org=\(identity.azureDevOps?.organization ?? "unknown", privacy: .public)")
#endif
            return credential
        }

        if let bearer = azureCLIAuthToken() {
#if DEBUG
            logger.debug("auth.azure.azCLI org=\(identity.azureDevOps?.organization ?? "unknown", privacy: .public)")
#endif
            return GitHostAuthorization(
                authorizationHeader: "Bearer \(bearer)",
                source: .azureCLI,
                expiresAt: Date().addingTimeInterval(240)
            )
        }

        return nil
    }

    private static func gitLabAuthorization(identity: GitRemoteIdentity) -> GitHostAuthorization? {
        let env = ProcessInfo.processInfo.environment
        let host = identity.gitLab?.host ?? identity.webURL?.host ?? "gitlab.com"
        if let token = trimmed(env["GITLAB_TOKEN"] ?? env["GL_TOKEN"] ?? env["GITLAB_PRIVATE_TOKEN"]), !token.isEmpty {
#if DEBUG
            logger.debug("auth.gitlab.env host=\(host, privacy: .public)")
#endif
            return GitHostAuthorization(
                authorizationHeader: "Bearer \(token)",
                source: .environment,
                expiresAt: Date().addingTimeInterval(cacheTTL)
            )
        }

        if let token = GitHostPATStore.loadToken(host: .gitLab, scope: host), !token.isEmpty {
#if DEBUG
            logger.debug("auth.gitlab.keychain host=\(host, privacy: .public)")
#endif
            return GitHostAuthorization(
                authorizationHeader: "Bearer \(token)",
                source: .personalAccessToken,
                expiresAt: Date().addingTimeInterval(cacheTTL)
            )
        }

        // `glab auth status --show-token --hostname <host>` writes the
        // human-readable status block to STDERR (not stdout) and the token
        // appears as `  ✓ Token found: glpat-...`. There is no plain
        // `glab auth token` subcommand in glab ≥ 1.x. Capture stderr and
        // grep for the marker.
        if let output = runCommand(
            executableCandidates: ["/opt/homebrew/bin/glab", "/usr/local/bin/glab", "glab"],
            arguments: ["auth", "status", "--show-token", "--hostname", host],
            timeout: 5,
            environment: [:],
            mergeStderr: true
        ), let token = parseGlabToken(output: output) {
#if DEBUG
            logger.debug("auth.gitlab.glabCLI host=\(host, privacy: .public)")
#endif
            return GitHostAuthorization(
                authorizationHeader: "Bearer \(token)",
                source: .glabCLI,
                expiresAt: Date().addingTimeInterval(cacheTTL)
            )
        }
        return nil
    }

    private static func parseGlabToken(output: String) -> String? {
        for line in output.split(whereSeparator: \.isNewline) {
            guard let range = line.range(of: "Token found:") else { continue }
            let token = line[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
            return token.isEmpty ? nil : token
        }
        return nil
    }

    private static func gitCredentialAuthorization(identity: GitRemoteIdentity) -> GitHostAuthorization? {
        guard let azure = identity.azureDevOps else { return nil }
        let stdin = """
        protocol=https
        host=dev.azure.com
        path=\(azure.organization)/\(azure.project)/_git/\(azure.repo)

        """
        guard let output = runCommand(
            executableCandidates: [GitExecutableResolver.resolvedGitPath() ?? "/usr/bin/git", "git"],
            arguments: ["credential", "fill"],
            timeout: 4,
            environment: [
                "GIT_TERMINAL_PROMPT": "0",
                "GCM_INTERACTIVE": "Never",
            ],
            stdin: stdin.data(using: .utf8)
        ) else {
#if DEBUG
            logger.debug("auth.azure.gitCredential.unavailable org=\(azure.organization, privacy: .public)")
#endif
            return nil
        }
        let fields = parseGitCredentialOutput(output)
        let username = fields["username"].flatMap(trimmed) ?? "termloop"
        guard let password = fields["password"].flatMap(trimmed), !password.isEmpty else {
            return nil
        }
        return GitHostAuthorization(
            authorizationHeader: basicAuth(username: username.isEmpty ? "termloop" : username, password: password),
            source: .gitCredential,
            expiresAt: Date().addingTimeInterval(cacheTTL)
        )
    }

    private static func azureCLIAuthToken() -> String? {
        runCommand(
            executableCandidates: ["/opt/homebrew/bin/az", "/usr/local/bin/az", "az"],
            arguments: [
                "account", "get-access-token",
                "--resource", azureDevOpsResource,
                "--query", "accessToken",
                "-o", "tsv",
            ],
            timeout: 6,
            environment: [:]
        )
    }

    private static func parseGitCredentialOutput(_ output: String) -> [String: String] {
        var fields: [String: String] = [:]
        for line in output.split(whereSeparator: \.isNewline) {
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eq])
            let value = String(line[line.index(after: eq)...])
            fields[key] = value
        }
        return fields
    }

    private static func runCommand(
        executableCandidates: [String],
        arguments: [String],
        timeout: TimeInterval,
        environment: [String: String],
        stdin: Data? = nil,
        mergeStderr: Bool = false
    ) -> String? {
        let executable = resolveExecutable(executableCandidates)
#if DEBUG
        logger.debug("auth.command.start executable=\(executable, privacy: .public) args=\(arguments.joined(separator: " "), privacy: .public) timeout=\(timeout)")
#endif
        let process = Process()
        if executable.hasPrefix("/") {
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = [executable] + arguments
        }
        var env = ProcessInfo.processInfo.environment
        for (key, value) in environment { env[key] = value }
        process.environment = env
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        // When merging, point stderr at the stdout pipe so glab-style tools
        // that write to stderr land in the same drain. The standalone `err`
        // pipe is then unused; closing its parent write end below makes its
        // drain return EOF immediately.
        process.standardError = mergeStderr ? out : err
        var inputPipe: Pipe?
        if stdin != nil {
            let pipe = Pipe()
            process.standardInput = pipe
            inputPipe = pipe
        }
        let semaphore = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in semaphore.signal() }
        let stdoutDrain = drain(out.fileHandleForReading)
        let stderrDrain = drain(err.fileHandleForReading)
        do {
            try process.run()
        } catch {
            process.terminationHandler = nil
            out.fileHandleForWriting.closeFile()
            err.fileHandleForWriting.closeFile()
#if DEBUG
            logger.debug("auth.command.launchFailed executable=\(executable, privacy: .public)")
#endif
            return nil
        }
        // Close parent-side writers so background drains observe EOF once the
        // child exits. Leaving these open can hang auth probes on group.wait().
        out.fileHandleForWriting.closeFile()
        err.fileHandleForWriting.closeFile()
        if let stdin, let inputPipe {
            inputPipe.fileHandleForWriting.write(stdin)
            inputPipe.fileHandleForWriting.closeFile()
        }
        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            if process.isRunning {
                process.terminate()
            }
            if semaphore.wait(timeout: .now() + 0.5) == .timedOut, process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                _ = semaphore.wait(timeout: .now() + 0.5)
            }
            process.terminationHandler = nil
            _ = stdoutDrain(1)
            _ = stderrDrain(1)
#if DEBUG
            logger.debug("auth.command.timeout executable=\(executable, privacy: .public) args=\(arguments.joined(separator: " "), privacy: .public)")
#endif
            return nil
        }
        process.terminationHandler = nil
        guard process.terminationStatus == 0 else {
#if DEBUG
            logger.debug("auth.command.failed executable=\(executable, privacy: .public) status=\(process.terminationStatus) args=\(arguments.joined(separator: " "), privacy: .public)")
#endif
            return nil
        }
        let data = stdoutDrain(max(1, min(5, timeout)))
        _ = stderrDrain(max(1, min(5, timeout)))
#if DEBUG
        logger.debug("auth.command.ok executable=\(executable, privacy: .public) bytes=\(data.count) args=\(arguments.joined(separator: " "), privacy: .public)")
#endif
        return trimmed(String(data: data, encoding: .utf8)).flatMap { $0.isEmpty ? nil : $0 }
    }

    private static func cacheKey(for identity: GitRemoteIdentity) -> CacheKey {
        switch identity.host {
        case .azureDevOps:
            let scope = identity.azureDevOps?.organization.lowercased()
                ?? identity.displaySlug.split(separator: "/").first.map { String($0).lowercased() }
                ?? identity.displaySlug.lowercased()
            return CacheKey(host: identity.host, scope: scope)
        case .github, .githubEnterprise:
            let host = identity.github?.host.lowercased()
                ?? identity.webURL?.host?.lowercased()
                ?? "github.com"
            return CacheKey(host: identity.host, scope: host)
        case .gitLab:
            let host = identity.gitLab?.host.lowercased()
                ?? identity.webURL?.host?.lowercased()
                ?? "gitlab.com"
            return CacheKey(host: identity.host, scope: host)
        case .unknown:
            return CacheKey(host: identity.host, scope: identity.displaySlug.lowercased())
        }
    }

    private static func drain(_ handle: FileHandle) -> (TimeInterval) -> Data {
        let group = DispatchGroup()
        let lock = NSLock()
        var data = Data()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            let drained = handle.readDataToEndOfFile()
            lock.lock()
            data = drained
            lock.unlock()
            group.leave()
        }
        return { timeout in
            if group.wait(timeout: .now() + timeout) == .timedOut {
                try? handle.close()
                _ = group.wait(timeout: .now() + 0.2)
            }
            lock.lock()
            let drained = data
            lock.unlock()
            return drained
        }
    }

    private static func resolveExecutable(_ candidates: [String]) -> String {
        for candidate in candidates {
            if candidate.hasPrefix("/") {
                if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
            } else if let resolved = GitExecutableResolver.resolve(executable: candidate) {
                return resolved
            }
        }
        return candidates.first ?? ""
    }

    private static func basicAuth(username: String, password: String) -> String {
        let token = Data("\(username):\(password)".utf8).base64EncodedString()
        return "Basic \(token)"
    }

    private static func trimmed(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum GitHostPATStore {
    static let didChangeNotification = Notification.Name("termloop.gitHostPATDidChange")
    private static let keychainService = "com.termloop.git-host-auth"

    static func normalizedScope(_ scope: String) -> String {
        scope.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func keychainAccount(host: GitHostKind, scope: String) -> String? {
        let normalizedScope = normalizedScope(scope)
        guard !normalizedScope.isEmpty else { return nil }
        switch host {
        case .azureDevOps:
            return "azure-devops:\(normalizedScope)"
        case .github, .githubEnterprise:
            return "\(host.rawValue):\(normalizedScope)"
        case .gitLab:
            return "gitlab:\(normalizedScope)"
        case .unknown:
            return nil
        }
    }

    static func loadToken(host: GitHostKind, scope: String) -> String? {
#if canImport(Security)
        guard let account = keychainAccount(host: host, scope: scope) else { return nil }
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        let token = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return token?.isEmpty == false ? token : nil
#else
        return nil
#endif
    }

    static func saveToken(_ token: String, host: GitHostKind, scope: String) throws {
#if canImport(Security)
        guard let account = keychainAccount(host: host, scope: scope) else {
            throw NSError(domain: "GitHostPATStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing host auth scope."])
        }
        let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedToken.isEmpty {
            try clearToken(host: host, scope: scope)
            return
        }
        let data = Data(normalizedToken.utf8)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
            kSecAttrAccount: account,
        ]
        let attributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw NSError(domain: NSOSStatusErrorDomain, code: Int(updateStatus))
            }
        } else if status != errSecSuccess {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        GitHostAuthResolver.resetCache()
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
#else
        throw NSError(domain: "GitHostPATStore", code: 2, userInfo: [NSLocalizedDescriptionKey: "Keychain is unavailable on this platform."])
#endif
    }

    static func clearToken(host: GitHostKind, scope: String) throws {
#if canImport(Security)
        guard let account = keychainAccount(host: host, scope: scope) else { return }
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
            kSecAttrAccount: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        GitHostAuthResolver.resetCache()
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
#endif
    }
}
