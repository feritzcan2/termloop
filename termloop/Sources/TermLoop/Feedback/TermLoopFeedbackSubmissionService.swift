// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

struct TermLoopFeedbackSubmissionMetadata {
    let appVersion: String
    let appBuild: String
    let appCommit: String
    let bundleIdentifier: String
    let osVersion: String
    let localeIdentifier: String
    let hardwareModel: String
    let chip: String
    let memoryGB: String
    let architecture: String
    let displayInfo: String
}

struct TermLoopFeedbackAttachmentSummary {
    let fileName: String
    let displaySize: String
}

enum TermLoopFeedbackSubmissionResult {
    case createdGitHubIssue(URL)
    case openedGitHubIssueDraft(URL)
}

enum TermLoopFeedbackSubmissionService {
    private static let githubIssueURLString = "https://github.com/feritzcan2/termloop/issues/new"
    private static let githubIssueTemplate = "feedback.yml"
    private static let githubRepository = "feritzcan2/termloop"

    static func submit(
        email: String,
        message: String,
        metadata: TermLoopFeedbackSubmissionMetadata,
        attachments: [TermLoopFeedbackAttachmentSummary]
    ) async -> TermLoopFeedbackSubmissionResult? {
        guard let issueURL = githubIssueURL(
            email: email,
            message: message,
            metadata: metadata,
            attachments: attachments
        ) else {
            return nil
        }

        if let createdIssueURL = await createGitHubIssueWithCLI(
            email: email,
            message: message,
            metadata: metadata,
            attachments: attachments
        ) {
            return .createdGitHubIssue(createdIssueURL)
        }

        let didOpen = await MainActor.run {
            NSWorkspace.shared.open(issueURL)
        }
        return didOpen ? .openedGitHubIssueDraft(issueURL) : nil
    }

    private static func githubIssueURL(
        email: String,
        message: String,
        metadata: TermLoopFeedbackSubmissionMetadata,
        attachments: [TermLoopFeedbackAttachmentSummary]
    ) -> URL? {
        guard var components = URLComponents(string: githubIssueURLString) else {
            return nil
        }

        components.queryItems = [
            URLQueryItem(name: "template", value: githubIssueTemplate),
            URLQueryItem(name: "title", value: issueTitle(for: message)),
            URLQueryItem(name: "feedback", value: message),
            URLQueryItem(name: "contact", value: email.trimmingCharacters(in: .whitespacesAndNewlines)),
            URLQueryItem(name: "app-info", value: appInfoBody(metadata)),
            URLQueryItem(name: "attachments", value: attachmentsBody(attachments)),
        ]
        return components.url
    }

    private static func createGitHubIssueWithCLI(
        email: String,
        message: String,
        metadata: TermLoopFeedbackSubmissionMetadata,
        attachments: [TermLoopFeedbackAttachmentSummary]
    ) async -> URL? {
        guard let ghURL = githubCLIExecutableURL() else {
            return nil
        }

        let title = issueTitle(for: message)
        let body = githubIssueBody(
            email: email,
            message: message,
            metadata: metadata,
            attachments: attachments
        )

        return await Task.detached(priority: .utility) {
            runGitHubIssueCreate(
                executableURL: ghURL,
                title: title,
                body: body
            )
        }.value
    }

    private static func githubCLIExecutableURL(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> URL? {
        let candidates = [
            environment["TERMLOOP_GH_PATH"],
            "/opt/homebrew/bin/gh",
            "/usr/local/bin/gh",
            "/usr/bin/gh",
        ].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }

        for path in candidates where !path.isEmpty && fileManager.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }

    private static func runGitHubIssueCreate(
        executableURL: URL,
        title: String,
        body: String
    ) -> URL? {
        let process = Process()
        process.executableURL = executableURL
        process.arguments = [
            "issue",
            "create",
            "--repo",
            githubRepository,
            "--title",
            title,
            "--body-file",
            "-",
            "--label",
            "enhancement",
        ]

        var environment = ProcessInfo.processInfo.environment
        environment["GH_PROMPT_DISABLED"] = "1"
        environment["GIT_TERMINAL_PROMPT"] = "0"
        process.environment = environment

        let inputPipe = Pipe()
        let outputPipe = Pipe()
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = outputPipe

        do {
            try process.run()
            if let data = body.data(using: .utf8) {
                inputPipe.fileHandleForWriting.write(data)
            }
            try? inputPipe.fileHandleForWriting.close()

            let completed = waitForProcess(process, timeout: 12)
            guard completed, process.terminationStatus == 0 else {
                if process.isRunning {
                    process.terminate()
                }
                return nil
            }

            let output = String(
                data: outputPipe.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? ""
            return firstGitHubIssueURL(in: output)
        } catch {
            return nil
        }
    }

    private static func waitForProcess(_ process: Process, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        return !process.isRunning
    }

    private static func firstGitHubIssueURL(in output: String) -> URL? {
        guard let range = output.range(
            of: #"https://github\.com/feritzcan2/termloop/issues/\d+"#,
            options: .regularExpression
        ) else {
            return nil
        }
        return URL(string: String(output[range]))
    }

    private static func githubIssueBody(
        email: String,
        message: String,
        metadata: TermLoopFeedbackSubmissionMetadata,
        attachments: [TermLoopFeedbackAttachmentSummary]
    ) -> String {
        [
            "## Feedback",
            "",
            message,
            "",
            "## Contact",
            "",
            email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Not provided"
                : email.trimmingCharacters(in: .whitespacesAndNewlines),
            "",
            "## App and system info",
            "",
            "```text",
            appInfoBody(metadata),
            "```",
            "",
            "## Attachments",
            "",
            attachmentsBody(attachments).isEmpty ? "None" : attachmentsBody(attachments),
        ].joined(separator: "\n")
    }

    private static func issueTitle(for message: String) -> String {
        let firstLine = message
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? "Feedback"
        let summary = firstLine.count > 72
            ? "\(firstLine.prefix(69))..."
            : firstLine
        return "Feedback: \(summary)"
    }

    private static func appInfoBody(_ metadata: TermLoopFeedbackSubmissionMetadata) -> String {
        [
            "App version: \(metadata.appVersion.isEmpty ? "unknown" : metadata.appVersion)",
            "App build: \(metadata.appBuild.isEmpty ? "unknown" : metadata.appBuild)",
            "App commit: \(metadata.appCommit.isEmpty ? "unknown" : metadata.appCommit)",
            "Bundle identifier: \(metadata.bundleIdentifier.isEmpty ? "unknown" : metadata.bundleIdentifier)",
            "macOS: \(metadata.osVersion.isEmpty ? "unknown" : metadata.osVersion)",
            "Locale: \(metadata.localeIdentifier.isEmpty ? "unknown" : metadata.localeIdentifier)",
            "Hardware model: \(metadata.hardwareModel.isEmpty ? "unknown" : metadata.hardwareModel)",
            "Chip: \(metadata.chip.isEmpty ? "unknown" : metadata.chip)",
            "Memory: \(metadata.memoryGB.isEmpty ? "unknown" : metadata.memoryGB)",
            "Architecture: \(metadata.architecture.isEmpty ? "unknown" : metadata.architecture)",
            "Displays: \(metadata.displayInfo.isEmpty ? "unknown" : metadata.displayInfo)",
        ].joined(separator: "\n")
    }

    private static func attachmentsBody(_ attachments: [TermLoopFeedbackAttachmentSummary]) -> String {
        guard attachments.isEmpty == false else {
            return ""
        }

        let attachmentLines = attachments.map { attachment in
            "- \(attachment.fileName) (\(attachment.displaySize))"
        }
        return ([
            "TermLoop cannot upload local files directly to GitHub.",
            "Please attach these files manually before submitting the issue:",
            "",
        ] + attachmentLines).joined(separator: "\n")
    }
}
