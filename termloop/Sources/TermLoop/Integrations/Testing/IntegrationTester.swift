// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Orchestrates test runs for individual items and bulk "test all".
/// All runners must honour timeouts — runaway processes are killed.
@MainActor
final class IntegrationTester {
    static let shared = IntegrationTester()

    private var runners: [IntegrationKind: TestRunner] = [
        .mcp: MCPTestRunner(),
        .cli: CLITestRunner(),
        .webhook: WebhookTestRunner(),
        .claudeHook: HookTestRunner(),
        .codexHook: HookTestRunner(),
        .geminiHook: HookTestRunner(),
    ]

    private init() {}

    @discardableResult
    func test(id: String) async -> IntegrationTestResult? {
        guard let item = IntegrationsStore.shared.item(id: id) else { return nil }
        IntegrationsStore.shared.updateItem(id: id) { $0.status = .running }
        let runner = runners[item.kind] ?? NullTestRunner()
        let result = await runner.run(item)
        await apply(result: result, to: id)
        return result
    }

    func testAll(limit: Int = 4) async {
        let pending = IntegrationsStore.shared.items
            .filter { if case .running = $0.status { return false } else { return true } }
        await withTaskGroup(of: Void.self) { group in
            var active = 0
            var iterator = pending.makeIterator()
            while active < limit, let next = iterator.next() {
                active += 1
                group.addTask { [weak self] in
                    _ = await self?.test(id: next.id)
                }
            }
            for await _ in group {
                if let next = iterator.next() {
                    group.addTask { [weak self] in
                        _ = await self?.test(id: next.id)
                    }
                }
            }
        }
    }

    private func apply(result: IntegrationTestResult, to id: String) async {
        IntegrationsStore.shared.updateItem(id: id) { item in
            item.lastTestedAt = Date()
            item.lastTestDurationMs = result.durationMs
            if !result.capabilities.isEmpty { item.capabilities = result.capabilities }
            item.status = result.success
                ? .ok(message: result.message)
                : .fail(reason: result.message)
        }
    }
}

protocol TestRunner: Sendable {
    func run(_ item: IntegrationItem) async -> IntegrationTestResult
}

struct NullTestRunner: TestRunner {
    func run(_ item: IntegrationItem) async -> IntegrationTestResult {
        .failure("No test runner for kind \(item.kind.rawValue)")
    }
}

enum IntegrationTestSupport {
    /// Launch a child process with a hard timeout. Returns
    /// (exitCode, combined stdout+stderr, wallClockMs). If the timeout
    /// fires, process is SIGKILL'd and exitCode is nil.
    static func run(command: String,
                    args: [String],
                    env: [String: String] = [:],
                    timeoutMs: Int) async -> (exit: Int32?, output: String, durationMs: Int) {
        let start = Date()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: command)
        proc.arguments = args
        if !env.isEmpty {
            var merged = ProcessInfo.processInfo.environment
            for (k, v) in env { merged[k] = v }
            proc.environment = merged
        }
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe

        do {
            try proc.run()
            pipe.fileHandleForWriting.closeFile()
        } catch {
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            return (nil, "launch failed: \(error.localizedDescription)", ms)
        }

        let deadline = DispatchTime.now() + .milliseconds(timeoutMs)
        let killed = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            DispatchQueue.global().async {
                while proc.isRunning {
                    if DispatchTime.now() > deadline {
                        proc.terminate()
                        Thread.sleep(forTimeInterval: 0.1)
                        if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
                        cont.resume(returning: true)
                        return
                    }
                    Thread.sleep(forTimeInterval: 0.05)
                }
                cont.resume(returning: false)
            }
        }
        let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        let output = String(data: data, encoding: .utf8) ?? ""
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        if killed { return (nil, output + "\n[timeout after \(timeoutMs)ms]", ms) }
        return (proc.terminationStatus, output, ms)
    }
}
