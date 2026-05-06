# TermLoop Watch — MVP

Apple Watch'tan tek butonla, sesli prompt vererek Mac'teki TermLoop'ta yeni bir worktree açıp varsayılan agent'ı başlatır.

## Mimari

İki yön var: **çıkış** (Watch tap → Mac'te agent başlat) ve **giriş** (Mac'te
agent turn'u biter → Watch'a bildirim → sesli cevap → Mac'e geri).

```
ÇIKIŞ:
Watch (dictation)  ──WCSession──▶  iPhone  ──TCP──▶  TermLoop
                                                       └─ watch.launch_agent
                                                          → fresh worktree + default agent + prompt

GİRİŞ:
TermLoop (workspace.attention event)  ──APNs──▶  iPhone  (UNNotification mirror)  ──▶  Watch
                                                                                          │
                                                                Watch user taps Reply, dictates
                                                                                          │
                                                  iPhone notification action handler ◀────┘
                                                       └─ watch.send_prompt → Mac terminal panel
```

Mac tarafı her iki RPC method'unu da ayakta tutuyor
(`termloop/Sources/TermLoop/Socket/WatchAgentSocketCommands.swift`):
- `watch.launch_agent { prompt }` — yeni worktree + agent.
- `watch.send_prompt { workspace_id, text }` — cevabı focused terminal'a yazar.

Push gönderimi mevcut `PushDispatcher`'a bağlı: o zaten `workspace.attention`
event'lerini APNs'e ileten kısmı yapıyor. Bu klasör sadece iPhone + Watch
tarafını içeriyor.

## Klasör yapısı

```
watch-app/
├── Shared/
│   ├── WatchBridgeProtocol.swift   # WCSession message keys (iOS+Watch ortak)
│   └── TermLoopRPC.swift           # iOS-only, NWConnection ile TCP RPC
├── iOS/
│   ├── TermLoopWatchApp.swift      # @main + AppDelegate + Ayar ekranı
│   ├── PhoneSessionDelegate.swift  # WCSession delegate (Watch → TCP forward)
│   ├── NotificationManager.swift   # APNs register + reply action handling
│   └── Settings.swift              # UserDefaults-backed config (WatchAppSettings)
└── Watch/
    ├── WatchAppMain.swift          # @main + tek-buton ekran + dictation
    └── WatchSessionClient.swift    # WCSession client (Watch → iPhone)
```

## Xcode'da kurulum (tek komut)

```bash
cd watch-app
./setup.sh
```

`setup.sh` xcodegen yoksa brew ile kurar, `project.yml`'den `TermLoopWatch.xcodeproj`'u üretir, Xcode'da açar. Hem iOS hem watchOS target'ları (kaynaklar, Info.plist, entitlements, Push capability) yapılandırılmış olarak gelir.

**Manuel müdahale gereken tek şey** — Xcode açıldıktan sonra:

1. **TermLoopWatch target → Signing & Capabilities → Team** bir Apple Developer Team seç. (Sadece simulator'de test edeceksen free Apple ID yeterli; gerçek cihaz veya Push için paid hesap + Apple Developer Identifier'da Push capability gerekiyor.)
2. **Watch simulator runtime yoksa**: Xcode → Settings → Platforms'tan "watchOS Simulator" indir.

`project.yml`'i değiştirip yeniden çalıştırmak istersen `xcodegen generate` yeter — proje sıfırdan üretilir. Yani Xcode'da yaptığın target ayarları (kaynak ekleme/silme/capability) `project.yml`'de yapılmalı, .xcodeproj direkt elle düzenlenmemeli.

Bundle ID'yi değiştirmek için `project.yml` içindeki iki `PRODUCT_BUNDLE_IDENTIFIER` satırını ve `WKCompanionAppBundleIdentifier`'ı düzenle, `xcodegen generate` ile yeniden üret.

## Mac tarafının hazır olması

`scripts/reload.sh --tag <tag>` ile Mac uygulamasını derle ve aç.
TermLoop ayarlarından:

- **Settings → Mobile** içindeki TCP listener'ı aç.
- **Socket Control** mode'u **Password** yap, parolayı belirle. Bu parola iPhone uygulamasındaki "Socket password" alanına girilecek.

LAN'da Mac'in IP'sini bul (örn. `ipconfig getifaddr en0`) ve iPhone Settings ekranına gir.
**Test connection** butonuna bas — `OK — connected` görmelisin.

### APNs (push) konfigürasyonu

Bildirimlerin Watch'a gitmesi için Mac'te APNs auth key tanımlanmalı:

1. Apple Developer → Keys → "+" ile yeni key oluştur, **Apple Push Notifications service (APNs)** check'le. `.p8` dosyasını indir, Key ID + Team ID'yi not al.
2. Dosyayı `~/Library/Application Support/termloop/apns/` altına kopyala (örn. `AuthKey_ABCD1234.p8`).
3. Aynı klasörde `config.json` oluştur:
   ```json
   {
     "team_id": "TEAMID12",
     "key_id": "ABCD1234",
     "key_file": "AuthKey_ABCD1234.p8",
     "bundle_id": "com.example.termloopwatch"
   }
   ```
   `bundle_id` Xcode'da iOS app target'ının bundle identifier'ı ile aynı olmalı.
4. TermLoop'u yeniden başlat — `PushDispatcher: APNs config missing` log'u kaybolup push pipeline ayağa kalkmalı.

**Sandbox vs production:** Xcode'dan iPhone'a Debug build ile yüklediğinde APNs token sandbox (development) için verilir; TestFlight/App Store build production için. iPhone uygulaması bu farkı `#if DEBUG` ile ayırıp Mac'e doğru `environment` değeriyle bildiriyor (`development` veya `production`). Mac'in `APNsClient.sendWithFallback` fonksiyonu önce primary environment'a yollar, başarısız olursa diğerine fallback eder — yani yanlış env seçimi sessizce başarısız olmaz. Yine de DEBUG iPhone build'ine production payload'ı asla gitmez (token cache fingerprint'e env de dahil).

iPhone'da uygulamayı ilk açtığında bildirim izni soracak; izin verince APNs token Mac'e otomatik kayıt olur (`push.register` RPC'si).

## Çalıştırma akışı (kullanım)

**Yeni agent başlatmak (çıkış yönü):**
1. Watch'ta TermLoop app'i aç → **New Agent** butonuna bas.
2. Sistem dictation ekranı açılır → konuş.
3. Bitince watch transcript'i iPhone'a gönderir.
4. iPhone Mac'e `watch.launch_agent` çağrısı yapar.
5. Mac'te yeni worktree (`watch/<timestamp>` branch'iyle) açılır, default agent başlar, sözünü prompt olarak alır.
6. Watch ✓ + branch ismini gösterir.

**Agent turn'u biter, sesli cevap (giriş yönü):**
1. Mac'te agent turn'u biter veya izin bekler → TermLoop `workspace.attention` event yayar.
2. `PushDispatcher` APNs üzerinden iPhone'a push gönderir (workspace_id payload'da).
3. iPhone bildirim gösterir, iOS otomatik olarak Watch'a mirror'lar.
4. Watch'ta bildirime dokun → "Reply" eyleminden dictation aç → konuş.
5. iPhone notification handler transcript'i alır, `watch.send_prompt { workspace_id, text }` çağırır.
6. Mac focused terminal'a metni + newline yazar — agent yeni turn'unu okur.

## Bilinen kısıtlar (MVP)

- iPhone uygulaması foreground/background'da olmalı. Tamamen kapalıysa Watch tap'i WCSession'ı uyandırır ama TCP cevabı gecikebilir.
- Parola UserDefaults'ta tutuluyor. Production'da Keychain'e taşı.
- Watch sadece iPhone bağlıyken çalışır. Cellular Watch için ayrı bir track gerekir (iPhone'suz TCP).
- Tek buton — quick action katalogu, project picker, status panosu yok. Hepsi sonraki iterasyonlar.
- **Hızlı çift-tap edge case:** WCSession reply deadline (~5s background) RPC timeout'undan (10s) kısa olabilir. iPhone arka planda uykuluyken tap → Watch timeout → RPC arka planda Mac'te worktree+agent yaratıyor → kullanıcı tekrar tap'larsa **ikinci** worktree+agent açılır. Çift launch tespiti için server-side request_id idempotency'si bir sonraki iterasyonda eklenmeli. Şimdilik Watch UI gönderim sırasında butonu disable ediyor; bu hata anına kadar koruma sağlıyor, ama hatadan sonra tekrar tap risk taşıyor.
- **Branch çakışması:** `mintBranchAvoidingCollision` aynı saniyede peş peşe tap'leri `-1`, `-2`... suffix'iyle ayırır (32 deneme limiti). Yine de manuel olarak aynı isimde branch yaratıp tap'larsan açıklayıcı bir hata (`worktree_invalid_params` vb.) görürsün.
- **Reply hedefi panel-spesifik değil:** `watch.send_prompt` workspace'in **focused** terminal panel'ına yazar. Multi-pane bir workspace'de bildirim sırasında focus farklı bir panel'a kaymışsa cevap yanlış pane'e gidebilir. Tek-panel agent workspace'lerinde sorun yok.

## Geliştirme notları

- `TermLoopRPC` her tap'te yeni TCP bağlantısı açıp kapatıyor. MVP için yeterli; persistent connection daha karmaşık (background TCP iOS'ta zor).
- Auth: v2 envelope (`{ method: "auth.login", params: { password } }`) — v1 `auth <password>` text protokolü değil.
- Worktree branch ismi `watch/yyyy-MM-dd-HHmmss` formatında otomatik üretilir (saniye hassasiyetinde, çakışma pratikte imkansız).
