// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import MarkdownUI
import SwiftUI

/// Read-only markdown renderer shared by every TermLoop markdown preview.
/// Parsing is delegated to MarkdownUI; this wrapper only applies TermLoop's
/// typography, spacing, and adaptive light/dark surfaces.
struct MarkdownRenderer: View {
    let content: String

    var body: some View {
        Markdown(content)
            .markdownTheme(.termLoop)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension Theme {
    static let termLoop = Theme.basic
        .text {
            FontSize(13)
            ForegroundColor(MarkdownTheme.bodyFg)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(12)
            BackgroundColor(MarkdownTheme.codeBg)
        }
        .link {
            ForegroundColor(.accentColor)
            UnderlineStyle(.single)
        }
        .heading1 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontSize(22)
                    FontWeight(.bold)
                    ForegroundColor(MarkdownTheme.bodyFg)
                }
                .markdownMargin(top: 8, bottom: 10)
        }
        .heading2 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontSize(18)
                    FontWeight(.bold)
                    ForegroundColor(MarkdownTheme.bodyFg)
                }
                .markdownMargin(top: 8, bottom: 10)
        }
        .heading3 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontSize(15)
                    FontWeight(.bold)
                    ForegroundColor(MarkdownTheme.bodyFg)
                }
                .markdownMargin(top: 4, bottom: 8)
        }
        .heading4 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontSize(13)
                    FontWeight(.bold)
                    ForegroundColor(MarkdownTheme.bodyFg)
                }
                .markdownMargin(top: 4, bottom: 8)
        }
        .heading5 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontSize(13)
                    FontWeight(.bold)
                    ForegroundColor(MarkdownTheme.bodyFg)
                }
                .markdownMargin(top: 4, bottom: 8)
        }
        .heading6 { configuration in
            configuration.label
                .markdownTextStyle {
                    FontSize(13)
                    FontWeight(.bold)
                    ForegroundColor(MarkdownTheme.secondaryFg)
                }
                .markdownMargin(top: 4, bottom: 8)
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.18))
                .markdownMargin(top: 0, bottom: MarkdownTheme.blockSpacing)
        }
        .blockquote { configuration in
            HStack(spacing: 10) {
                Rectangle()
                    .fill(MarkdownTheme.codeBorder)
                    .frame(width: 2)
                configuration.label
                    .markdownTextStyle {
                        ForegroundColor(MarkdownTheme.secondaryFg)
                    }
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: 0, bottom: MarkdownTheme.blockSpacing)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.16))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(12)
                    }
                    .padding(MarkdownTheme.codePadding)
            }
            .background(MarkdownTheme.codeBg)
            .overlay(Rectangle().stroke(MarkdownTheme.codeBorder, lineWidth: 1))
            .markdownMargin(top: 0, bottom: MarkdownTheme.blockSpacing)
        }
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: 0, bottom: MarkdownTheme.bulletSpacing)
        }
        .thematicBreak {
            Rectangle()
                .fill(MarkdownTheme.rule)
                .frame(height: 1)
                .markdownMargin(top: 4, bottom: 4)
        }
        .table { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .markdownTableBorderStyle(.init(color: MarkdownTheme.codeBorder))
                .markdownTableBackgroundStyle(
                    .alternatingRows(Color.clear, MarkdownTheme.insetBg)
                )
                .markdownMargin(top: 0, bottom: MarkdownTheme.blockSpacing)
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    if configuration.row == 0 {
                        FontWeight(.semibold)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .relativePadding(.horizontal, length: .em(0.72))
                .relativePadding(.vertical, length: .em(0.35))
        }
}
