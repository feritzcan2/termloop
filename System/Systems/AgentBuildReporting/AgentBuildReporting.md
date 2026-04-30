# Agent Build Reporting

## Amaç

`Agent Build Reporting`, termloop içinden açılan agent oturumlarında build,
preview ve artifact linklerini kullanıcı ek talimat vermeden yakalayıp
sidebar'da görünür hale getirmeyi amaçlar.

Temel hedefler:

- `Claude` ve `Codex` için `termloop` MCP'sini otomatik bağlamak
- Agent shell komutlarından build/dev niyetini otomatik çıkarmak
- Build sonunda oluşan `file://...app` veya preview URL'lerini
  sidebar chip'ine çevirmek
- `Worktree Agents` ve `Active Agents` altında aynı state'i göstermek

## Nasıl Çalışır

Akış hibrit bir yapıdır:

- `MCP-first`: agent isterse `report_link` tool'unu çağırabilir
- `cmux-first`: agent çağırmasa bile termloop shell ve stop-hook üzerinden
  link üretmeye çalışır

Bu yüzden sistem sadece "agent hatırlarsa çalışır" seviyesinde değildir.

## MCP Enjeksiyonu

Yerleşik MCP sunucusu:

- ad: `termloop`
- tool: `report_link`
- transport: `stdio`
- command: `cmux termloop-mcp`

Bağlantı kuralları:

- Claude için proje kapsamına `~/.claude.json ->
  projects["<cwd>"].mcpServers.termloop` yazılır
- Codex için global `~/.codex/config.toml` içine
  `[mcp_servers.termloop]` bölümü yazılır
- Yeni açılan session'lar bunu otomatik alır

Önemli not:

- Mevcut açık session'lar geriye dönük güncellenmez
- Kullanıcının yeni agent başlatması gerekir

## Claude Deferred Tool Sorunu

Claude Code, MCP tool'larını bazen `MCPSearch` üzerinden deferred modda
yükler. Bu durumda agent `report_link` tool'unu doğrudan görmeyip önce
`ToolSearch` yapmak zorunda kalabilir.

Bu akış TermLoop için istenmeyen bir davranıştı çünkü:

- agent tool'u kullanmayı atlayabiliyordu
- kullanıcı "neden report_link çağırmadın" diye sormak zorunda kalıyordu

Bu yüzden termloop wrapper'ı Claude session'larını şu ayarla başlatır:

- `disallowedTools = ["MCPSearch"]`

Böylece `termloop.report_link` eager görünür olmaya zorlanır.

## Shell Heuristics

Agent terminalinde çalışan komutlar `BASH_ENV` tabanlı monitor ile izlenir.

Sistem şu sinyalleri üretir:

- `Build: xcodebuild`
- `Build: reload.sh`
- `Build: npm build`
- `Preview: localhost:3000`

Label üretimi generic normalize edilir:

- shell wrapper'ları atılır
- ilk anlamlı executable bulunur
- build/dev/preview intent'i kısa etikete çevrilir

Bu yüzden sistem yalnızca termloop projesine özel değildir.

## Artifact ve Preview Yükseltmesi

Build komutu başladığında ilk chip çoğu zaman bir niyet etiketi olur:

- `Build: xcodebuild`

Sonrasında agent final mesajında aşağıdakilerden birini yazarsa chip
gerçek linke yükseltilir:

- `file:///...TermLoop DEV.app`
- `http://localhost:3000`
- `https://...`

Bu yükseltme iki yoldan biriyle olur:

- agent doğrudan `report_link` çağırır
- termloop stop-hook transcript'i parse edip `workspace.report_agent_link`
  yazar

## False Positive Filtreleri

Her URL preview değildir. Sistem şu tür linkleri ignore eder:

- OAuth / login / authorize URL'leri
- rate-limit / usage endpoint'leri
- provider bootstrap URL'leri

Örnek ignore edilenler:

- `api.anthropic.com/api/oauth/usage`
- `/oauth/`
- `/login`
- `/authorize`
- `/rate_limits`

Ayrıca agent bootstrap komutları da preview üretmez:

- `claude`
- `codex`
- `aider`
- `open`
- `xdg-open`

## Sidebar Davranışı

Raporlanan link state'i hem metadata store'a hem de agent activity
state'ine yazılır.

UI tarafında şu yerlerde görünür:

- `Worktree Agents`
- `Active Agents`

Öncelik kuralı:

- build link'i daha zayıf preview/curl gürültüsü tarafından overwrite edilmez

## Kullanıcı Deneyimi

Beklenen kullanıcı akışı:

1. Kullanıcı termloop içinde yeni bir Claude veya Codex agent açar
2. Agent build/dev komutu çalıştırır
3. Sidebar'da kısa bir chip görünür
4. Build bitince gerçek app path ya da preview URL bulunduysa chip
   gerçek linke döner

Kullanıcının ayrıca:

- MCP kurması
- config düzenlemesi
- `report_link` demesi

gerekmez.
