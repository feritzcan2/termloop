// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum VariableSubstitution {
    enum Error: Swift.Error, Equatable, CustomStringConvertible {
        case unknownVariable(String)
        var description: String {
            switch self {
            case .unknownVariable(let n): return "unknown template variable: {{\(n)}}"
            }
        }
    }

    static func apply(_ template: String, values: [String: String]) throws -> String {
        var out = ""
        var i = template.startIndex
        while i < template.endIndex {
            if template[i...].hasPrefix("{{"),
               let close = template.range(of: "}}", range: i..<template.endIndex) {
                let nameStart = template.index(i, offsetBy: 2)
                let name = String(template[nameStart..<close.lowerBound])
                    .trimmingCharacters(in: .whitespaces)
                guard let value = values[name] else {
                    throw Error.unknownVariable(name)
                }
                out += value
                i = close.upperBound
            } else {
                out.append(template[i])
                i = template.index(after: i)
            }
        }
        return out
    }
}
