> この翻訳は Claude によって生成されました。改善の提案がある場合は、PR を作成してください。

<h1 align="center">TermLoop</h1>
<p align="center">AIコーディングエージェント向けの縦タブと通知機能を備えたGhosttyベースのmacOSターミナル</p>

<p align="center">
  <a href="https://github.com/feritzcan2/termloop/releases/latest/download/termloop-macos.dmg">
    <img src="./docs/assets/macos-badge.png" alt="macOS版TermLoopをダウンロード" width="180" />
  </a>
</p>

<p align="center">
  <a href="README.md">English</a> | 日本語 | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.it.md">Italiano</a> | <a href="README.da.md">Dansk</a> | <a href="README.pl.md">Polski</a> | <a href="README.ru.md">Русский</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.ar.md">العربية</a> | <a href="README.no.md">Norsk</a> | <a href="README.pt-BR.md">Português (Brasil)</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.km.md">ភាសាខ្មែរ</a> | <a href="README.uk.md">Українська</a>
</p>

<p align="center">
  <a href="https://x.com/manaflowai"><img src="https://img.shields.io/badge/@manaflow-555?logo=x" alt="X / Twitter" /></a>
  <a href="https://github.com/feritzcan2/termloop/discussions"><img src="https://img.shields.io/badge/Discord-555?logo=discord" alt="Discord" /></a>
  <a href="https://github.com/feritzcan2/termloop"><img src="https://img.shields.io/github/stars/feritzcan2/termloop?style=flat&logo=github&label=stars&color=4c71f2" alt="GitHub stars" /></a>
</p>

<p align="center">
  <img src="./docs/assets/main-first-image.png" alt="TermLoopスクリーンショット" width="900" />
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=i-WxO5YUTOs">▶ デモ動画</a> · <a href="https://termloop.ai/blog/zen-of-cmux">The Zen of TermLoop</a>
</p>

## 機能

<table>
<tr>
<td width="40%" valign="middle">
<h3>通知リング</h3>
コーディングエージェントがあなたの注意を必要とするとき、ペインに青いリングが表示され、タブが点灯します
</td>
<td width="60%">
<img src="./docs/assets/notification-rings.png" alt="通知リング" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>通知パネル</h3>
保留中のすべての通知を一か所で確認、最新の未読にジャンプ
</td>
<td width="60%">
<img src="./docs/assets/sidebar-notification-badge.png" alt="サイドバー通知バッジ" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>アプリ内ブラウザ</h3>
<a href="https://github.com/vercel-labs/agent-browser">agent-browser</a>から移植されたスクリプタブルなAPIで、ターミナルの横にブラウザを分割表示
</td>
<td width="60%">
<img src="./docs/assets/built-in-browser.png" alt="内蔵ブラウザ" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>縦タブ + 横タブ</h3>
サイドバーにgitブランチ、リンクされたPRのステータス/番号、作業ディレクトリ、リッスン中のポート、最新の通知テキストを表示。水平・垂直に分割可能。
</td>
<td width="60%">
<img src="./docs/assets/vertical-horizontal-tabs-and-splits.png" alt="縦タブと分割ペイン" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>SSH</h3>
<code>cmux ssh user@remote</code> でリモートマシン用のワークスペースを作成。ブラウザペインはリモートネットワーク経由でルーティングされるため、localhostがそのまま動作します。リモートセッションに画像をドラッグするとscpでアップロードされます。
</td>
<td width="60%">
<img src="./docs/assets/ssh.png" alt="TermLoop SSH" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Claude Code Teams</h3>
<code>cmux claude-teams</code> でClaude Codeのチームメイトモードをワンコマンドで実行。チームメイトはネイティブ分割として生成され、サイドバーのメタデータと通知が表示されます。tmuxは不要です。
</td>
<td width="60%">
<img src="./docs/assets/claude-code-teams.png" alt="Claude Code Teams" width="100%" />
</td>
</tr>
</table>

- **ブラウザインポート** — Chrome、Firefox、Arc、その他20以上のブラウザからCookie、履歴、セッションをインポートして、ブラウザペインを認証済みの状態で開始
- **カスタムコマンド** — [`cmux.json`](https://termloop.ai/docs/custom-commands)でプロジェクト固有のアクションを定義し、コマンドパレットから実行
- **スクリプタブル** — CLIとsocket APIでワークスペースの作成、ペインの分割、キーストロークの送信、ブラウザの自動化が可能
- **ネイティブmacOSアプリ** — SwiftとAppKitで構築、Electronではありません。高速起動、低メモリ消費。
- **Ghostty互換** — 既存の`~/.config/ghostty/config`からテーマ、フォント、カラーを読み込み
- **GPU高速化** — libghosttyによるスムーズなレンダリング

## インストール

### DMG（推奨）

<a href="https://github.com/feritzcan2/termloop/releases/latest/download/termloop-macos.dmg">
  <img src="./docs/assets/macos-badge.png" alt="macOS版TermLoopをダウンロード" width="180" />
</a>

`.dmg`ファイルを開き、TermLoopをアプリケーションフォルダにドラッグしてください。TermLoopはSparkle経由で自動更新されるため、ダウンロードは一度だけで済みます。

### Homebrew

```bash
brew tap feritzcan2/termloop
brew install --cask termloop
```

後で更新する場合：

```bash
brew upgrade --cask termloop
```

初回起動時、macOSが確認済みの開発者からのアプリを開くことの確認を求める場合があります。**開く**をクリックして続行してください。

## なぜTermLoop？

私はClaude CodeとCodexのセッションを多数並列で実行しています。Ghosttyで大量の分割ペインを使い、エージェントが私を必要としているときを知るためにmacOSのネイティブ通知に頼っていました。しかし、Claude Codeの通知本文はいつも「Claude is waiting for your input」というコンテキストのないものばかりで、タブを十分に開くとタイトルすら読めなくなっていました。

いくつかのコーディングオーケストレーターを試しましたが、そのほとんどがElectron/Tauriアプリで、パフォーマンスが気になりました。また、GUIオーケストレーターはそのワークフローに縛られるため、単純にターミナルのほうが好みです。そこで、TermLoopをSwift/AppKitのネイティブmacOSアプリとして構築しました。ターミナルレンダリングにはlibghosttyを使用し、テーマ、フォント、カラーは既存のGhostty設定を読み込みます。

主な追加機能はサイドバーと通知システムです。サイドバーには、各ワークスペースのgitブランチ、リンクされたPRのステータス/番号、作業ディレクトリ、リッスン中のポート、最新の通知テキストを表示する縦タブがあります。通知システムはターミナルシーケンス（OSC 9/99/777）を検出し、Claude Code、OpenCodeなどのエージェントフックに接続できるCLI（`cmux notify`）を備えています。エージェントが待機中のとき、そのペインに青いリングが表示され、サイドバーのタブが点灯するので、分割やタブをまたいでどれが私を必要としているかがわかります。Cmd+Shift+Uで最新の未読にジャンプします。

アプリ内ブラウザには[agent-browser](https://github.com/vercel-labs/agent-browser)から移植されたスクリプタブルなAPIがあります。エージェントはアクセシビリティツリーのスナップショットを取得し、要素参照を取得し、クリック、フォーム入力、JSの評価が可能です。ターミナルの横にブラウザペインを分割し、Claude Codeに開発サーバーと直接やり取りさせることができます。

すべてがCLIとsocket APIを通じてスクリプタブルです — ワークスペース/タブの作成、ペインの分割、キーストロークの送信、ブラウザでのURL表示。

## The Zen of TermLoop

TermLoopは開発者のツールの使い方を規定しません。ターミナルとブラウザにCLIがあり、あとはあなた次第です。

TermLoopはソリューションではなくプリミティブです。ターミナル、ブラウザ、通知、ワークスペース、分割、タブ、そしてそのすべてを制御するCLIを提供します。TermLoopはコーディングエージェントの使い方を強制しません。プリミティブで何を構築するかはあなた次第です。

優れた開発者は常に自分のツールを構築してきました。エージェントとの最適な作業方法はまだ誰も見つけていませんし、クローズドな製品を作っているチームも見つけていません。自分のコードベースに最も近い開発者が最初に見つけるでしょう。

100万人の開発者にコンポーザブルなプリミティブを与えれば、どんなプロダクトチームがトップダウンで設計するよりも速く、最も効率的なワークフローを集合的に見つけ出すでしょう。

## ドキュメント

TermLoopの設定方法の詳細は、[ドキュメントをご覧ください](https://termloop.ai/docs/getting-started?utm_source=readme)。

## キーボードショートカット

### ワークスペース

| ショートカット | アクション |
|----------|--------|
| ⌘ N | 新規ワークスペース |
| ⌘ 1–8 | ワークスペース1–8にジャンプ |
| ⌘ 9 | 最後のワークスペースにジャンプ |
| ⌃ ⌘ ] | 次のワークスペース |
| ⌃ ⌘ [ | 前のワークスペース |
| ⌘ ⇧ W | ワークスペースを閉じる |
| ⌘ ⇧ R | ワークスペースの名前を変更 |
| ⌘ B | サイドバーの表示切替 |

### サーフェス

| ショートカット | アクション |
|----------|--------|
| ⌘ T | 新規サーフェス |
| ⌘ ⇧ ] | 次のサーフェス |
| ⌘ ⇧ [ | 前のサーフェス |
| ⌃ Tab | 次のサーフェス |
| ⌃ ⇧ Tab | 前のサーフェス |
| ⌃ 1–8 | サーフェス1–8にジャンプ |
| ⌃ 9 | 最後のサーフェスにジャンプ |
| ⌘ W | サーフェスを閉じる |

### 分割ペイン

| ショートカット | アクション |
|----------|--------|
| ⌘ D | 右に分割 |
| ⌘ ⇧ D | 下に分割 |
| ⌥ ⌘ ← → ↑ ↓ | 方向でペインにフォーカス |
| ⌘ ⇧ H | フォーカス中のパネルを点滅 |

### ブラウザ

ブラウザの開発者ツールのショートカットはSafariのデフォルトに従い、`設定 → キーボードショートカット`でカスタマイズできます。

| ショートカット | アクション |
|----------|--------|
| ⌘ ⇧ L | 分割でブラウザを開く |
| ⌘ L | アドレスバーにフォーカス |
| ⌘ [ | 戻る |
| ⌘ ] | 進む |
| ⌘ R | ページを再読み込み |
| ⌥ ⌘ I | 開発者ツールの表示切替（Safariデフォルト） |
| ⌥ ⌘ C | JavaScriptコンソールを表示（Safariデフォルト） |

### 通知

| ショートカット | アクション |
|----------|--------|
| ⌘ I | 通知パネルを表示 |
| ⌘ ⇧ U | 最新の未読にジャンプ |

### 検索

| ショートカット | アクション |
|----------|--------|
| ⌘ F | 検索 |
| ⌘ G / ⌘ ⇧ G | 次を検索 / 前を検索 |
| ⌘ ⇧ F | 検索バーを非表示 |
| ⌘ E | 選択範囲で検索 |

### ターミナル

| ショートカット | アクション |
|----------|--------|
| ⌘ K | スクロールバックをクリア |
| ⌘ C | コピー（選択時） |
| ⌘ V | ペースト |
| ⌘ + / ⌘ - | フォントサイズを拡大 / 縮小 |
| ⌘ 0 | フォントサイズをリセット |

### ウィンドウ

| ショートカット | アクション |
|----------|--------|
| ⌘ ⇧ N | 新規ウィンドウ |
| ⌘ , | 設定 |
| ⌘ ⇧ , | 設定を再読み込み |
| ⌘ Q | 終了 |

## ナイトリービルド

[TermLoop NIGHTLYをダウンロード](https://github.com/feritzcan2/termloop/releases/download/nightly/termloop-nightly-macos.dmg)

TermLoop NIGHTLYは独自のバンドルIDを持つ別のアプリなので、安定版と並行して実行できます。最新の`main`コミットから自動的にビルドされ、独自のSparkleフィード経由で自動更新されます。

## セッション復元（現在の動作）

再起動時、TermLoopは現在アプリのレイアウトとメタデータのみを復元します：
- ウィンドウ/ワークスペース/ペインのレイアウト
- 作業ディレクトリ
- ターミナルのスクロールバック（ベストエフォート）
- ブラウザのURLとナビゲーション履歴

TermLoopはターミナルアプリ内のライブプロセスの状態を復元**しません**。例えば、アクティブなClaude Code/tmux/vimセッションは再起動後にまだ再開されません。

## Star History

<a href="https://star-history.com/#feritzcan2/termloop&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=feritzcan2/termloop&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=feritzcan2/termloop&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=feritzcan2/termloop&type=Date" width="600" />
 </picture>
</a>

## コントリビューション

参加方法：

- Xでフォロー：[@manaflowai](https://x.com/manaflowai)、[@lawrencecchen](https://x.com/lawrencecchen)、[@austinywang](https://x.com/austinywang)
- [Discord](https://github.com/feritzcan2/termloop/discussions)で会話に参加
- [GitHubのIssues](https://github.com/feritzcan2/termloop/issues)や[ディスカッション](https://github.com/feritzcan2/termloop/discussions)に参加
- TermLoopで何を構築しているか教えてください

## コミュニティ

- [Discord](https://github.com/feritzcan2/termloop/discussions)
- [GitHub](https://github.com/feritzcan2/termloop)
- [X / Twitter](https://github.com/feritzcan2/termloop)
- [YouTube](https://www.youtube.com/channel/UCAa89_j-TWkrXfk9A3CbASw)
- [LinkedIn](https://www.linkedin.com/company/manaflow-ai/)
- [Reddit](https://www.reddit.com/r/termloop/)

## Founder's Edition

TermLoopは無料でオープンソースであり、今後もそうあり続けます。開発をサポートし、次に来る機能への早期アクセスを得たい方へ：

**[Founder's Editionを入手](https://buy.stripe.com/3cI00j2Ld0it5OU33r5EY0q)**

- **機能リクエスト/バグ修正の優先対応**
- **早期アクセス：すべてのワークスペース、タブ、パネルのコンテキストを提供するTermLoop AI**
- **早期アクセス：デスクトップと携帯電話間でターミナルを同期するiOSアプリ**
- **早期アクセス：クラウドVM**
- **早期アクセス：ボイスモード**
- **私の個人的なiMessage/WhatsApp**

## ライセンス

TermLoopは[GPL-3.0-or-later](LICENSE)の下でオープンソースです。

GPLに準拠できない組織向けに、商用ライセンスもご用意しています。詳細は[feritzcan93@gmail.com](mailto:feritzcan93@gmail.com)までお問い合わせください。
