// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

public struct DevServerDetectedURL: Equatable, Hashable, Sendable {
    public let originalText: String
    public let normalizedString: String

    public var url: URL? { URL(string: normalizedString) }
}

public enum DevServerURLDetector {
    private static let fullURLRegex = try! NSRegularExpression(
        pattern: #"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[(?:::1|::)\])(?::\d{1,5})?(?:[/?#][^\s'\"<>]*)?"#,
        options: [.caseInsensitive]
    )

    private static let bareURLRegex = try! NSRegularExpression(
        pattern: #"(?<![A-Za-z][A-Za-z0-9+.-]://)(?<![A-Za-z0-9_.-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[(?:::1|::)\]):\d{1,5}(?:/[^\s'\"<>]*)?"#,
        options: [.caseInsensitive]
    )

    private static let trailingTrimCharacters = CharacterSet(charactersIn: ".,;:!?")
    private static let delimiterPairs: [Character: Character] = [
        ")": "(",
        "]": "[",
        "}": "{"
    ]

    public static func detect(in line: String) -> [DevServerDetectedURL] {
        guard !line.isEmpty else { return [] }
        let nsRange = NSRange(line.startIndex..<line.endIndex, in: line)
        var consumedRanges: [NSRange] = []
        var detected: [DevServerDetectedURL] = []

        for match in fullURLRegex.matches(in: line, options: [], range: nsRange) {
            guard let found = detectedURL(in: line, range: match.range, hasScheme: true) else { continue }
            detected.append(found)
            consumedRanges.append(match.range)
        }

        for match in bareURLRegex.matches(in: line, options: [], range: nsRange) {
            guard !consumedRanges.contains(where: { NSIntersectionRange($0, match.range).length > 0 }),
                  let found = detectedURL(in: line, range: match.range, hasScheme: false) else {
                continue
            }
            detected.append(found)
        }

        var seen = Set<String>()
        return detected.filter { seen.insert($0.normalizedString).inserted }
    }

    public static func normalize(_ raw: String) -> String? {
        let trimmed = trimTrailingDelimiters(raw)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: trailingTrimCharacters)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#, options: .regularExpression) == nil
            ? "http://\(trimmed)"
            : trimmed
        guard var components = URLComponents(string: withScheme),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host?.lowercased(),
              isAllowedLocalHost(host) else {
            return nil
        }
        if host == "0.0.0.0" || host == "::" || host == "::1" {
            components.host = "localhost"
        }
        components.scheme = scheme
        return components.url?.absoluteString
    }

    private static func detectedURL(in line: String, range: NSRange, hasScheme: Bool) -> DevServerDetectedURL? {
        guard let swiftRange = Range(range, in: line) else { return nil }
        let original = String(line[swiftRange])
        let normalizedInput = hasScheme ? original : "http://\(original)"
        guard let normalized = normalize(normalizedInput) else { return nil }
        return DevServerDetectedURL(originalText: original, normalizedString: normalized)
    }

    private static func trimTrailingDelimiters(_ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        value = value.trimmingCharacters(in: trailingTrimCharacters)

        while let last = value.last,
              let opening = delimiterPairs[last],
              value.filter({ $0 == last }).count > value.filter({ $0 == opening }).count {
            value.removeLast()
            value = value.trimmingCharacters(in: trailingTrimCharacters)
        }
        return value
    }

    private static func isAllowedLocalHost(_ host: String) -> Bool {
        host == "localhost"
            || host == "127.0.0.1"
            || host == "0.0.0.0"
            || host == "::1"
            || host == "::"
    }
}
