# Integrations Tab

## Amaç

`Integrations` tabı, agent oturumlarının kullanabildiği dış entegrasyonları tek yerde göstermeyi amaçlar:

- MCP sunucuları
- CLI araçları
- Webhook girdileri
- Claude hook’ları
- Codex hook’ları

Tabın temel sorusu şudur:

- Bu workspace içinde hangi entegrasyonlar keşfedildi?
- Bunlar şu anda gerçekten kullanılabilir mi?
- Hangileri spawn’a attach edilebilir?
- Hangileri tavsiye edilmeli?

## Sidebar Entegrasyonu

Tab, sidebar’a yeni bir sekme olarak eklenmiştir:

- `TermLoopSidebarTab`: `.integrations`
- `TermLoopSidebarRoot`: `IntegrationsTab(projectRoot: activeProjectFolderURL)`

Bu yüzden entegrasyon keşfi aktif proje köküne bağlı çalışır. `projectRoot` değiştiğinde store yeniden refresh olur.

## Ana Veri Modeli

Merkez tip `IntegrationItem`’dır.

- `id`: `"<kind>:<name>"`
- `kind`: `mcp`, `cli`, `webhook`, `claudeHook`, `codexHook`
- `displayName`
- `summary`
- `source`
- `status`
- `lastTestedAt`
- `lastTestDurationMs`
- `capabilities`
- `configRef`
- `attachedToActiveSpawn`
- `binaryPath`
- `version`
- `authSubject`

`source.precedence` şu sırayla merge edilir:

- `projectScope`
- `systemPath`
- `userScope`
- `termLoop`

Bu sayede aynı integration birden fazla kaynaktan gelirse proje kapsamı kullanıcı kapsamını ezer.

## Store ve Cache

`IntegrationsStore` tabın merkezi state objesidir.

- Discovery modüllerini paralel çalıştırır.
- Sonuçları `mergeById` ile birleştirir.
- Son durumları disk cache’e yazar.
- İstenirse refresh sonrası otomatik `testAll()` çalıştırır.

Kullanılan discovery listesi:

- `MCPDiscovery`
- `CLIDiscovery`
- `WebhookDiscovery`
- `ClaudeHookDiscovery`
- `CodexHookDiscovery`

Cache yolu:

- `~/Library/Application Support/TermLoop/integrations/cache.json`

Önemli güncelleme:

- Cache formatı artık versiyonludur.
- `CacheEnvelope(version: 2, records: ...)` kullanılır.
- Eski bozuk cache formatı artık okunmaz.

Bu değişiklik özellikle daha önce `~/.claude.json` içindeki alakasız top-level key’lerin sahte MCP gibi görünmesi sorununu temizlemek için eklendi.

## Discovery Kuralları

### MCP

`MCPDiscovery` şu kaynakları okur:

- `~/.claude.json`
- `projects["<abs-path>"].mcpServers` içindeki Claude proje ayarları
- `~/.codex/config.toml` içindeki `[mcp_servers.*]`
- `~/.gemini/settings.json` içindeki `mcpServers`
- `projectRoot/.mcp.json`
- `projectRoot/.gemini/settings.json`

Önemli düzeltme:

- Claude tarafında artık sadece gerçek `mcpServers` alanı parse edilir.
- Top-level fallback kaldırılmıştır.
- Böylece `additionalModelCostsCache`, `oauthAccount`, `skillUsage`, `tipsHistory` gibi Claude internal key’leri artık MCP olarak görünmez.

Sonradan eklenen parça:

- Gemini CLI settings dosyalarından MCP discovery desteği eklendi.
- Bu hem user scope hem project scope için geçerli.

### CLI

`CLIDiscovery` aday binary listesini PATH üzerinde tarar.

Örnek adaylar:

- `claude`
- `codex`
- `gemini`
- `application-insights` (backed by `az`)
- `wrangler`
- `gh`
- `aws`
- `gcloud`
- `jira`
- `kubectl`
- `aider`

Önemli düzeltme:

- Sadece environment `PATH` değil, yaygın kullanıcı dizinleri de taranır.
- Özellikle `~/.bun/bin`, `~/.local/bin`, `~/bin` eklendi.

Bu sayede `codex` gibi user-local kurulumlar daha güvenilir keşfedilir.

Application Insights notu:

- Ayrı bir standalone binary olarak değil, `az` tabanlı mantıksal CLI entegrasyonu olarak modellenmiştir.
- Microsoft Learn’e göre App Insights komutları `az monitor app-insights` altında çalışır.
- Bunun için `application-insights` Azure CLI extension’ı gerekir.

Not:

- Mevcut implementasyon binary bulunmasa bile birçok CLI için satır üretir.
- Bu satırlar `status = .fail("not installed")` ile görünür.
- Yani CLI bölümü sadece kurulu araçları değil, beklenen ama eksik olan araçları da listeleyebilir.

### Claude Hooks

`ClaudeHookDiscovery` şu kaynaklardan hook okur:

- `~/.claude/settings.json`
- `projectRoot/.claude/settings.json`

Her hook entry için:

- `displayName`: `EventName · matcher`
- `summary`: komutların birleştirilmiş hali

### Codex Hooks

Önemli düzeltme:

- Codex hook discovery artık `~/.codex/config.toml` taramıyor.
- Doğru kaynak `~/.codex/hooks.json`.

Bu dosyadaki `hooks` objesinden event bazlı item üretilir:

- `SessionStart`
- `UserPromptSubmit`
- `Stop`

Varsa matcher bilgisi `displayName` içine alınır.

## Test Altyapısı

`IntegrationTester` tüm testleri orkestre eder.

- Tek item testi: `test(id:)`
- Toplu test: `testAll(limit: 4)`

Runner dağılımı:

- `mcp -> MCPTestRunner`
- `cli -> CLITestRunner`
- `webhook -> WebhookTestRunner`
- `claudeHook -> HookTestRunner`
- `codexHook -> HookTestRunner`

`IntegrationTestSupport.run(...)` hard-timeout ile child process çalıştırır.

## Hook Testi

`HookTestRunner` hook komutunu yan etkisiz biçimde statik olarak doğrular.

Önemli düzeltme:

- Shell wrapper komutlarından gerçek executable ayıklanır.
- `cmux codex-hook ...` gibi zincirli command ifadeleri artık yanlış negatif üretmez.
- Absolute path ya da PATH lookup ile executable kontrol edilir.

## Recommendation Sistemi

`RecommendationEngine` repo sinyallerine göre öneri üretir.

Şu anki heuristic’ler:

- `wrangler`
- `jira-mcp`
- `context7`
- `gh`
- `aws`

Öneri aksiyonları:

- `add(presetId?)`
- `fix(step)`
- `configure`

Dismiss edilen öneriler disk üzerinde tutulur:

- `~/Library/Application Support/TermLoop/integrations/dismissed.json`

## Recommended Akışı

`IntegrationsRecommendedGroup` önerileri sticky üst grup gibi render eder.

Buton davranışı:

- `Fix`: ilgili integration için test tetikler
- `Configure…`: preset sheet açar
- `+ Add`: artık doğrudan config sheet açmaz

Önemli son ekleme:

- `+ Add` artık `Install Help` sheet açar
- Bu sheet sadece yönlendirici kurulum rehberi verir
- Uygulama binary ya da MCP paketi otomatik kurmaz

Desteklenen rehberler:

- `application-insights`
- `wrangler`
- `gh`
- `aws`
- `context7`
- `jira-mcp`

Sheet içeriği:

- adım listesi
- örnek terminal komutları
- MCP snippet örnekleri
- uygunsa `Configure…` butonuna geçiş

Bu akış, spec’in “auto-install yok” kararını bozmadan kullanıcıya uygulama içi yardım sağlar.

## Configure Akışı

`IntegrationsConfigSheet` preset tabanlı çalışır.

Preset registry’de şu an bulunan preset’ler:

- `WranglerPreset`
- `GhCliPreset`
- `AwsCliPreset`
- `GcloudCliPreset`
- `CodexCliPreset`
- `GeminiCliPreset`
- `JiraCliPreset`
- `JiraMCPPreset`

Sonradan eklenen parça:

- `ApplicationInsightsCliPreset`
- `GeminiCliPreset`
- `JiraCliPreset`
- `JiraMCPPreset`

Persist modeli:

- Non-secret alanlar `config.json`
- Secret alanlar macOS Keychain

Config dosyası:

- `~/Library/Application Support/TermLoop/integrations/config.json`

Keychain service:

- `com.termloop.integrations`

Secret placeholder çözümü:

- `${keychain:<presetId>:<key>}`

## Spawn’a Attach Etme

`IntegrationsSpawnPrep` attach edilen integration’lardan geçici spawn artefact’ları üretir.

Yaptıkları:

- Seçili MCP’lerden geçici `mcp-config.json` üretir
- Secret placeholder’ları expand eder
- Webhook URL’lerini env var olarak ekler
- Desteklenen agent komutlarına `--mcp-config` inject eder

Desteklenen command rewrite:

- `claude`
- `codex`
- `aider`

Env değişkenleri:

- `CLAUDE_MCP_CONFIG`
- `CODEX_MCP_CONFIG`

Temp dizin:

- `/tmp/termloop-integrations-<workspaceId>/`

## Mevcut Limitler

- Install Help sheet kurulum yapmaz, sadece rehber sunar.
- `JiraMCPPreset` secret’ları saklar ama `~/.claude.json` ya da `~/.codex/config.toml` içine gerçek MCP stanza yazmaz.
- `IntegrationsSpawnPrep.resolveMCPEntry(...)` şu an temel olarak `.claude.json` ve project-scope dosya üzerinden yeniden okuma yapıyor.
- Bu yüzden Gemini settings veya bazı Codex-only MCP kaynakları discovery’de görünse de spawn prep tarafında ayrı ele alınmaları gerekebilir.
- UI tarafında row/detail akışı MVP düzeyindedir; install yardımında copy button veya one-click terminal launch yoktur.

## Kullanıcıya Görünen Sonuç

Tab artık şunları daha doğru yapıyor:

- Sahte MCP girdilerini göstermiyor
- `codex` binary’sini daha iyi buluyor
- `Codex Hooks` bölümünü gerçek `hooks.json` üzerinden gösteriyor
- `Recommended > +Add` ile uygulama içi kurulum yardım akışı açıyor
- Eski cache yüzünden yanlış state taşımıyor

## Dosya Haritası

Ana dosyalar:

- `termloop/Sources/TermLoop/Integrations/IntegrationsStore.swift`
- `termloop/Sources/TermLoop/Integrations/IntegrationKind.swift`
- `termloop/Sources/TermLoop/Integrations/IntegrationItem.swift`
- `termloop/Sources/TermLoop/Integrations/Discovery/*.swift`
- `termloop/Sources/TermLoop/Integrations/Testing/*.swift`
- `termloop/Sources/TermLoop/Integrations/Recommendations/*.swift`
- `termloop/Sources/TermLoop/Integrations/Config/*.swift`
- `termloop/Sources/TermLoop/Integrations/Spawn/*.swift`
- `termloop/Sources/TermLoop/Integrations/UI/*.swift`

Sidebar wiring:

- `termloop/Sources/TermLoop/UI/Sidebar/TermLoopSidebarTab.swift`
- `termloop/Sources/TermLoop/UI/TermLoopSidebarRoot.swift`

Localization ve project registration:

- `termloop/Resources/TermLoop.xcstrings`
- `termloop/GhosttyTabs.xcodeproj/project.pbxproj`
