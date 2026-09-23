# Agent Apps — MVP1, MVP2, MVP3 uygulama planı

Tarih: 23 Eylül 2026. Durum: uygulama planı; ürün geliştirmesi başlamadı.

Bu belge üç büyük teslimatı tek bir uygulama goal'ünde tamamlamak için yazılmıştır. MVP1, MVP2 ve MVP3 aynı ürünün birbirine bağlı aşamalarıdır; ilk aşamada durmak goal'ü tamamlamaz. Buradaki kutular uygulama sırasında kanıtlarıyla birlikte güncellenir.

Önce [ürün fikrini ve amaçlarını](agent-apps-idea.md) oku. Bu iki dosya birlikte önceki konuşmaya ihtiyaç bırakmayan goal girdisidir.

## 1. Ürün ve tamamlanmış davranış

Kullanıcı amacını anlatır. Agent gerekli bilgileri toplar; hangi kayıtların, dosyaların, sayfaların, bağlantıların ve arka plan görevlerinin gerektiğini önerir ve oluşturur. Kullanıcının önceden ekran, veritabanı veya cron tasarlaması gerekmez. Agent yaptığı işi bu uygulama üzerinden sürdürür; kullanıcı hem oluşan ekranlardan hem agent oturumundan işi yönetebilir.

Referans deneyimler:

- İş arama: profil oluşturma, ilan bulma, uygunluk değerlendirme, CV/cover letter üretme ve inceleme, başvuru durumu ve belge takibi.
- Berlin ev arama: kriterleri toplama, ilan bulma, tekrarları ayıklama, uygunluğu açıklama, mesaj hazırlama/gönderme, cevap ve ziyaret takibi; verilen süre sonunda otomatik durma.
- Kullanıcı "ziyaret notları için bir sayfa da lazım" dediğinde agent mevcut kayıtları koruyarak uygulamayı genişletir. Agent ihtiyaç gördüğünde bu genişletmeyi kendisi de önerir.
- Oluşan uygulama tanımı başka bir kullanıcıya aktarılabilir. Yeni kullanıcı kendi profilini, bağlantılarını ve verilerini kullanır; yazarın kişisel kayıtları paylaşılmaz.

## 2. Goal için çalışma sözleşmesi

- Üç MVP'nin tamamı zorunludur. Çalışan bir genel dashboard, yalnız fixture sonuçları veya yalnız bir prompt paketi bitiş değildir.
- Kullanıcının açık önkoşulu: **ilk ürün kodu yazılmadan önce mevcut yerel değişikliklerin tamamı commit ve push edilmiş olmalı.** Bu hazırlık tesliminde mevcut değişiklikler bu yetkiyle dahil edilir. Uygulama goal'ü başlarken checkpoint ve remote eşitliği doğrulanır; daha sonra ortaya çıkan ilgisiz/eşzamanlı değişiklikler korunur.
- Ürün için geçici teknik ad `Agent Apps` kullanılır; isim/marka çalışması kapsam dışıdır.
- Yerleşim varsayımı: aynı monorepoda ayrı masaüstü uygulaması ve ayrı servis. TermLoop'un günlük kullanılan uygulamasına yeni ürün ekranları eklenmez. Kullanıcının sonraki açık tercihi bu kararı değiştirir.
- İlk teslimat yerelde çalışır. Paylaşım gerçek paket export/import ve kurulum üzerinden tamamlanır. Hosted marketplace, ücretlendirme, herkese açık hesap servisi ve eşzamanlı ortak düzenleme bu goal'ün dışında kalır.
- Arayüz kapalıyken, çalıştırıcı makine açık olduğu sürece otomasyon sürer. Bilgisayar kapalıyken çalışma sözü verilmez; uzak/hosted çalıştırıcı sonraki ürün aşamasıdır.
- macOS üzerinde gerçek masaüstü kabul testi yapılır. Diğer platformlarda mevcut taşınabilir parçalar korunur; çalıştırılmayan platformlar açıkça unmeasured olarak raporlanır.
- Mevcut kullanıcı verileri yalnız seçilen kökten, açık import işlemiyle alınır; tüm disk veya özel mesajlar taranmaz.
- Bu belgenin uygulanması yeni kaynak sınırları, protokol, veri şeması ve geliştirme komutları için yetki verir. Mevcut TermLoop yetki kapsamlarını veya domain kurallarını gevşetme yetkisi vermez.

## 3. Kaynaklar ve yeniden kullanım sınırı

İnceleme anındaki TermLoop commit'i: `77460e5c1b0c42992e9ba5f352aab0718bc0c403`. Uygulamaya başlarken güncel kaynak tekrar doğrulanır; bu commit'e reset yapılmaz.

Referans iş arama paketi: [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search), incelenen upstream commit: [`120f476a089358363ceaf2528f52edf2854994bd`](https://github.com/MadsLorentzen/ai-job-search/commit/120f476a089358363ceaf2528f52edf2854994bd). Upstream MIT lisanslıdır; alınan dosyalarla lisans ve kaynak bilgisi korunur. Kullanıcının yerel fork'u bu sürümle aynı kabul edilmez.

| Kaynak | Kullanım kararı |
| --- | --- |
| `modules/terminal`, `modules/platform` | PTY, süreç ağacı, attach/detach, binary akış, dosya ve credential ilkel işlemlerini yeniden kullan. |
| `modules/agents`, `modules/invocation` | Provider gözlemi, yetenek keşfi ve doğrulanmış başlatma/continue davranışını adaptör üzerinden kullan. İşletim politikasını mevcut `core`dan topluca kopyalama. |
| `clients/desktop/src/renderer/terminal/` | Gerekli terminal yüzeyi parçalarını bağımlılıklarını ölçerek kullan. Mekanik çıkarma gerekiyorsa davranış değişikliğinden ayrı tut. |
| `apps/server` MCP ve contract codegen | Şema üretimi, scope kontrolü ve bağlantı ilkelerini örnek al; yeni ürünün sözleşmesini ayrı namespace'te üret. |
| Routine scheduler ve Workflow Creator | Claim/deadline, kurucu agent ve sürümleme örneklerinden yararlan. Kod odaklı Discuss/Implement/Review/Fix akışını genel iş motoru sayma. |
| `modules/store` | Atomik yazma ve revision yaklaşımı örnektir. `state.v1.json` yeni ürünün iş veritabanı olarak kullanılmaz. |
| ai-job-search | Çalışma metodunu ve işe özgü uzmanlığı koruyan ilk domain paketi. Markdown talimatlarını hazır backend API'si sanma. |

Mevcut AGENTS metinlerinin bir kısmı hâlâ Worker yapısını anlatır; incelenen kaynakta Routine yürütümü Steward'a bağlanmıştır. Uygulamada güncel executable kaynak esas alınır.

## 4. Mimari kararlar

### 4.1 Kaynak sahipliği

Yeni ürünün önerilen sınırları:

- `modules/app-domain`: uygulama tanımı, instance, kayıt, görev ve işlem durumlarının saf kuralları.
- `modules/app-store`: SQLite şeması, migrations, transaction'lar, sorgular ve kalıcı iş geçmişi.
- `modules/app-core`: isimlendirilmiş komutlar, builder/runtime koordinasyonu, package ve action politikası.
- `modules/app-connectors`: yeni ürünün dış hizmet erişimi; HTTP, mesaj ve browser adaptörleri ile gerektiğinde sınırlı subprocess protokolü.
- `apps/agent-apps-server`: API/MCP, terminal akışı, scheduler uyanışı ve bağımsız servis yaşam döngüsü.
- `clients/agent-apps-desktop`: Electron/React kabuğu, terminal ve üretilen sayfa host'u.
- `contract`: yeni ürün için ayrı şema ve generated Rust/TypeScript paketleri; mevcut TermLoop kontrol DTO'larına app kayıtları eklenmez.
- `resources/app-packs`: sürümlü iş arama ve ev arama paketleri; kişisel veri bulunmaz.
- `tests/e2e/agent-apps`: fixture servisleri, gerçek agent kabul akışları ve kanıt üretimi.

Yeni domain/store, eski TermLoop Project/Task store'una bağımlı olmaz. OS işlemleri platform'da kalır. Yeni server yalnız kendi core'una ve gerekli terminal/platform/contract sınırlarına bağlanır. DAG ve boundary denetimleri yeni açık sınırlar için genişletilir; denetimler kapatılmaz. `common/`, `shared/`, `utils/` oluşturulmaz.

Zorunlu mimari/tooling dilimi:

| Sınır | Somut değişiklik ve doğrulama |
| --- | --- |
| Rust DAG | `app-domain → []`; `app-store → app-domain, platform`; `app-connectors → platform`; `app-core → app-domain, app-store, app-connectors, platform, terminal, agents, invocation`; yeni server → yeni contract, app-core, terminal, platform. Invocation'ın mevcut domain bağımlılığı transitif adaptör detayıdır; yeni iş domain'i bu tipe bağlanmaz. |
| Agent launch | İkinci sahiplik noktası tam olarak `modules/app-core/src/agent_launch/mod.rs`. Payload üretimi invocation'da kalır. Bu dosyada izinli, komşu dosyada yasak spawn fixture'ı eklenir. Program adını değişkenden geçirerek scanner'dan kaçılmaz. |
| Kalıcı yazma | Yeni app-store ve app-core için açık kural eklenir. Server/client'ın transaction commit etmesi negatif fixture ile reddedilir; mevcut TermLoop kuralı gevşetilmez. |
| Network | App connector egress'i yalnız yeni connector sınırında ve runtime yetkileriyle bulunur. Network'ü script'e saklamak sınırdan muafiyet değildir; subprocess da aynı scope/timeout/receipt sözleşmesine tabidir. |
| Contract | `contract/schema/agent-apps.v1.schema.json`, ayrı codegen giriş noktası ve `contract/generated/agent-apps-rust`, `contract/generated/agent-apps-typescript` çıktıları. Root codegen/drift bunları kapsar; `control.current` bu ürün için genişletilmez. |
| Terminal yüzeyi | Client-to-client source import yok. Gerekli renderer-neutral parçalar `clients/terminal-surface` workspace paketine davranışsız refaktör olarak ayrılabilir; iki istemci sonra bu dar paketi tüketir. Transport/proje modelini pakete taşıma. |

Mekanik terminal çıkarma tamamlanıp eski testler geçmeden yeni davranış eklenmez. Yeni DAG/sahiplik değişikliği ayrı dilimdir; mekanik refaktörle karıştırılmaz. Yeni ürün sınırları için AGENTS dosyaları ve negatif mimari fixture'ları da teslimata dahildir.

### 4.2 Veri ve gerçeklik kaynakları

| Kavram | Kalıcı içerik |
| --- | --- |
| `AppDefinitionVersion` | Veri şemaları, sayfalar, agent talimatları, iş tarifleri, gerekli bağlantı tipleri, paket bağımlılıkları. Değişmez sürüm. |
| `AppInstance` | Yüklü sürüm, kullanıcıya ait ayarlar, çalışma kapsamı ve etkin bağlantı referansları. |
| `Collection` / `Record` | Şema doğrulamalı iş kayıtları; kaynak, zaman, revision ve instance kimliği. |
| `Artifact` | Yönetilen dosya, hash, sürüm, MIME, kaynak kayıt/run ilişkisi. Dosya byte'ları yönetilen dosya deposunda. |
| `JobDefinition` | Tetikleyici, talimat/entrypoint, girdi, başlangıç-bitiş, saat dilimi, timeout, eşzamanlılık ve sınırlar. |
| `JobRun` | Belirli bir çalıştırma ve bağlı app sürümü; durum, checkpoint, zamanlar, sonuç ve agent oturumu referansı. |
| `Action` | Dış etki niyeti, deduplication anahtarı, giriş özeti, sonucu doğrulayan receipt veya belirsizlik. |
| `Activity` | Kayıt/dosya/run/action'a bağlı iş olayı; terminal transcript'i değildir. |

Her iş kaydı ve sorgu `app_instance_id` ile scope edilir; scope MCP argümanına güvenilerek seçilmez. Yeni ürün kendi state/runtime dizinlerini kullanır. Secret değerler SQLite'a, sayfa bundle'ına, export'a veya loglara yazılmaz; credential depoya opaque referans tutulur.

İş kayıtları JSON dokümanı olarak, generic indekslerle tutulur: instance/collection/id, revision, güncellenme zamanı ve gerektiğinde unique dedup key. Agent her collection için tablo veya SQL/DDL oluşturmaz. Şema değişikliği doğrulanmış bir uygulama sürümüdür. SQLite işi kontrollü worker/connection sahibi üzerinden yürür; blocking sorgu async event loop'u kilitlemez.

Uygulama tanımının authoritative kaynağı veritabanındaki immutable sürümdür. Diskteki page/tool bundle'ları hash ile bu sürüme bağlıdır; staging dizini yayınlanana kadar etkin değildir. Export, sürümün türetilmiş paketidir. Aynı tanımın bağımsız değişebilen DB ve klasör kopyaları tutulmaz.

Agent'ın dosya düzenleyebilmesi için server, doğrulanmış taslak snapshot'ını bir çalışma dizinine materyalize eder. Publish adımı dosyaları doğrular ve immutable sürüm/blob'lara alır; etkin runtime yalnız o snapshot'ı kullanır. Yayınlanmamış dosya değişiklikleri etkin tanım değildir. Geçici dizin silinirse son kaydedilmiş taslak/yayınlı snapshot yeniden üretilebilir; henüz kaydedilmemiş editlerin kurtarılacağı vaat edilmez.

İş kaydı ve ilgili Activity aynı transaction'da yazılır. Canlı event akışı commit sonrasında yayımlanır. Bağlantısı kopan istemci revision/cursor ile veritabanından eksik görünümü yeniden alır. Terminal byte'ları, agent durum sinyalleri ve iş olayları ayrı kanallardır.

### 4.3 Agent ve sayfa sınırı

- Kurucu agent ihtiyacı okuyup app tanımının taslak sürümünü değiştirir. İşi yürüten agent/run yayımlanmış bir sürüme bağlı çalışır. Bunlar ayrı sorumluluklardır; her işlem için ayrı bir LLM çağrısı veya sürekli açık iki agent zorunlu değildir.
- MCP araç aileleri: app incele/revise/publish, collection tanımla/sorgula, kayıt upsert, artifact ekle/oku, page publish, job oluştur/düzenle/duraklat, run report/complete, action execute/reconcile, package export/import.
- Her araç şema doğrulamalı, instance/session scope'lu ve gerektiğinde idempotency/revision korumalıdır. Agent'a uygulamanın doğrudan SQLite dosyası verilmez.
- Agent gerçek sayfa kodu üretir. Host'un hazır birkaç ekranından birini seçmek tek başına kabul edilmez. Tablo/form gibi hazır bileşenler kullanılabilir.
- Üretilen sayfa izole origin/sandbox içinde çalışır; Node, shell, host credential ve diğer instance'lara erişmez. Veri/eylem erişimi dar bir host bridge üzerinden olur. Ayrı oturumlarda capability ve mesaj kaynağı doğrulanır.
- Opaque/null-origin iframe kullanılıyorsa `event.origin` tek başına kimlik sayılmaz: exact source window, kısa ömürlü nonce/capability ve manifest scope birlikte doğrulanır. Kısıtlı CSP ve bridge davranışı gerçek Electron penceresinde test edilir; yalnız kaynak regex'i yeterli değildir.
- İlk handshake doğrulanmış iframe'e MessageChannel port'u aktarır; sonraki çağrılar yalnız o porttan kabul edilir. Unload capability'yi iptal eder. iframe'de same-origin, forms ve popups yetkileri yoktur; harici script/iframe ve doğrudan fetch engellenir. Gerekli bağımlılıklar doğrulanmış bundle içine alınır.
- Sayfa derlenip doğrulandıktan sonra app sürümüyle yayınlanır. Bozuk yeni sürüm çalışan ekranı kaldırmaz. Frontend rollback, veri migration'ını otomatik geri almış sayılmaz.
- Uygulama oluşturma, ekran ekleme ve mevcut yetkiler içindeki değişikliklerde tekrar tekrar onay istenmez. Yeni bağlantı veya dış etki yetkisi gerektiğinde yalnız ilgili eksik yetki görünür şekilde alınır.

**Çalıştırıcı yetkisinin sınırı:** MCP aracı tek başına sandbox değildir. Aynı OS kullanıcısı altında boş cwd, 0700 klasör veya temiz env, shell erişimi olan bir agent'tan home/keychain/browser verisini korumaz. Otonom `managed` çalıştırıcıda ham shell, keychain, host dosyaları, raw browser/CDP ve serbest egress gerçekten kısıtlanır. Provider tool allowlist'i ve izin profili yeterliyse bunun negatif testleri yapılır; yetmiyorsa OS/container izolasyonu gerekir. Kısıt doğrulanmadan unattended dış işlem modu destekleniyor sayılmaz. Bunun için gereken runtime bağımlılığı kurulumda görünür olmalıdır.

Geniş yetkili etkileşimli geliştirme oturumu sunulursa ayrı, açık bir developer modudur; managed job güvenceleri ona atfedilmez. Paylaşılan paketin kodu veya talimatları bu moda otomatik geçiş yaptıramaz. Connector sırlarını yalnız credential broker/connector yürütücüsü çözer; sır depoyu aynı kullanıcıdan okuyabilen serbest shell bırakıp yalnız env redaksiyonuna güvenilmez.

### 4.4 Background iş ve dış etki semantiği

- İlk tetikleyiciler: şimdi çalıştır, bir defalık zaman, sabit aralık ve seçilmiş kayıt olayı. Saat dilimi açık saklanır; çalışma penceresi backend tarafından uygulanır.
- Varsayılan bir job için tek aktif run. Claim/lease ve kayıtları kalıcıdır; birden fazla servis aynı instance işini sahiplenemez.
- Uyku/kapalı kalma sonrası kaçırılan aralıklar varsayılan tek catch-up run'a birleşir. Bitiş zamanı geçmiş görev yeniden başlatılmaz.
- Pause yeni run'ları durdurur. Cancel aktif run'a durma iletir; dış eylem sınırlarında iptal/bitiş tekrar kontrol edilir. Gönderilmiş mesaj geri alınmış gibi gösterilmez.
- Güvenli salt-okuma adımları sınırlı backoff ile tekrar denenebilir. Dış eylem sonuçsuz kaldığında kör retry yapılmaz; `unknown` olarak tutulur ve reconcile gerekir. Exactly-once dış teslim iddiası yoktur.
- Run durumları: `queued`, `running`, `waiting_input`, `succeeded`, `failed`, `cancelled`, `interrupted`. Duraklama job'a aittir. Dış işlem durumu ayrı tutulur: `prepared`, `dispatching`, `confirmed`, `failed`, `unknown`.
- Servis crash'inden kalan run önce interrupted/reconcile durumuna alınır; tüm adımlar baştan körlemesine yürütülmez. Devam mümkünse son güvenli checkpoint'ten sürdürülür.
- Agent'ın "yaptım" demesi teslim kanıtı değildir. Gerçek dış etki, connector receipt'i veya doğrulanmış hedef durumuyla tamamlanır.
- Dedupe kimliği backend tarafından instance, eylem türü, canonical hedef ve kararlı mantıksal işlem kimliğinden hesaplanır. Sadece hedefi kullanıp meşru takip mesajlarını sonsuza kadar engelleme; agent'ın rastgele yeni key üretip aynı gönderimi çoğaltmasına da izin verme. Yeni takip işlemi açık ayrı niyet ve geçerli politikaya bağlıdır.

### 4.5 Browser ve connector kapsamı

BrowserSession connector'a ait kaynak olur. Agent'a cookie deposu yolu, CDP adresi veya kullanıcının kişisel browser profili verilmez. Giriş gerekiyorsa connector denetimindeki headed pencere kullanıcıya açılır, run `waiting_input` olur; doğrulanmış oturum koşulundan sonra devam eder. Agent okuma/çıkarma veya tanımlı eylem ister; sınırsız browser otomasyonu yetkisi almaz.

MVP2 connector teslimatı: HTTP/JSON veya RSS okuma, IMAP ilan-alarm okuma ve SMTP mesaj gönderme; ayrıca login/oturum/devralma mekanizmasının kontrollü browser fixture'ı. Chromium/üretim browser bağımlılığı ve process supervision açık kurulur; repodaki mevcut test Playwright bağımlılığı hazır üretim browser altyapısı sayılmaz. Belirli bir emlak portalının anti-bot veya login akışının desteklendiği yalnız o portalda ölçülür. Böyle bir portalın seçilmemesi genel ürün goal'ünü engellemez; destek listesine eklenmez.

Kimlik bilgisi gerektirmeyen canlı bir HTTP/RSS kaynak okunur. IMAP/SMTP ve login için kendi kontrollü servislerinde gerçek protokol trafiği doğrulanır; dosyaya yazan fake gönderici bunun yerine geçmez. Dış posta sağlayıcısı teslimi ve gerçek ev sahibine/işverene ulaşma ayrı kanıttır ve izinsiz test edilmez. Kullanıcının gerçek hesabı yoksa bu sınır raporlanır; kontrollü protokol kanıtı dış sağlayıcıda başarı olarak sunulmaz.

## 5. MVP1 — Agent'ın uygulama oluşturduğu çalışma alanı

**Teslimat:** Kullanıcı doğal dille isteğini anlatır; gerçek agent kendi veri yapısını ve ekranlarını oluşturur. Kullanıcı kayıtlarını, dosyalarını ve agent oturumunu birlikte yönetir. Uygulama yeniden açıldığında veriler korunur.

### Todo

- [ ] M1-01 İlk ürün kodundan önce kullanıcının istediği commit/push checkpoint'ini doğrula. Başlangıç repo/çalışma ağacı durumunu kaydet; ilgili AGENTS'ları oku, sonraki ilgisiz değişikliklere dokunma. Yeni sınırların DAG'ını ve yerel komutlarını tanımla.
- [ ] M1-02 Terminal/platform/provider yeniden kullanımını bağımlılıklarıyla doğrula. Gerekli mekanik çıkarma varsa ayrı davranışsız dilim olarak yap ve mevcut terminal/provider testlerini geçir.
- [ ] M1-03 Ayrı servis ve masaüstü uygulamasını, ayrı discovery/state/runtime dizinleri ve isimlendirilmiş start/status/stop komutlarıyla kur. Kullanıcının ana TermLoop uygulamasını durdurma.
- [ ] M1-04 SQLite migrations, instance scope, transaction, revision kontrolü ve yönetilen dosya deposunu kur. AppDefinitionVersion, AppInstance, Record ve Artifact işlemlerini tamamla.
- [ ] M1-05 Yeni API/MCP sözleşmesini schema-first oluştur; Rust/TypeScript üretimini ve drift kontrolünü ekle. Hataları typed olarak döndür.
- [ ] M1-06 Gerçek kurucu agent başlatma, MCP bağlantısı, durum gözlemi, terminal attach/detach ve yeniden bağlanmayı çalıştır. En az mevcut kullanıcının tercih ettiği agent ile gerçek E2E kanıtı üret.
- [ ] M1-07 Kurucu agent'a kaynak ve yetenek kataloğu ver; ihtiyaçtan collection, page ve iş taslağı üretmesini sağla. Eksik kullanıcı bilgilerini hedefli sorularla toplasın.
- [ ] M1-08 App tanımı için taslak, doğrulama, yayın ve önceki sürümü seçme akışını uygula. Devam eden instance veri bütünlüğünü koru.
- [ ] M1-09 Sayfa bundle'ı üretme/derleme/publish ve izole sayfa host'unu kur. Host bridge'de instance scope, origin/capability ve giriş şeması denetimini uygula.
- [ ] M1-10 Masaüstünde uygulama listesi, uygulama navigasyonu, özel sayfalar, dosya önizleme, activity ve agent terminaline erişim oluştur. Bunlar gerçek backend verisini kullansın.
- [ ] M1-11 PDF, metin/Markdown ve görsel önizlemesini kayıtlarla ilişkilendir. Belgenin taslak ve kullanılan/gönderilen sürümlerini ayırt et.
- [ ] M1-12 ai-job-search için açık import adaptörü yaz: seçilen kökün tracker CSV'si, ilan durumu ve başvuru arşivlerini mapping ile aktar. Tekrar import duplicate oluşturmasın; kaynak dosyaları değiştirmesin. Aynı şirket/role ait farklı tarihli gerçek başvuruları fuzzy match ile birleştirme. Kaynak kimliğini ve ham bilinmeyen durumları koru; çakışma ve eksik alanlar görünür olsun.
- [ ] M1-13 İş arama uzmanlığını kaynak/lisans bilgisiyle ilk pack'e al. Doğrulanmış profil, kriterler, yazım stili, çıktı şablonları ve kontrol adımlarını koru; kişisel örnek veri ekleme.
- [ ] M1-14 Canlı veri güncellemesi ve yeniden bağlanma sonrası refetch/revision toparlanmasını tamamla. Kayıt + activity atomikliğini doğrula.
- [ ] M1-15 İlk milestone kabul senaryolarını çalıştır ve dokümandaki kanıt tablosuna sonuçları işle.

### Kabul kriterleri

- **A1:** Boş instance'da "iş başvurularımı yönet" talimatından sonra gerçek agent kullanıcıdan gerekli bilgileri toplar, veriye bağlı bir başvuru sayfası üretir. Sayfa geliştirici tarafından önceden o senaryoya özel doldurulmuş değildir.
- **A2:** Bir kayıt açıldığında ilişkili CV/cover letter ve kaynak ilan görünür. Kaydı UI'dan değiştirmek backend'e, agent'tan değiştirmek UI'ya yansır.
- **A3:** "Görüşme hazırlığı için ayrı sayfa ekle" isteğiyle agent yeni sayfa oluşturur. Önceki kayıtlar ve dosyalar korunur. Bozuk sayfa sürümü mevcut sayfayı bozmaz.
- **A4:** Servis ve UI yeniden başlatıldıktan sonra kayıtlar/dosyalar geri gelir. İkinci instance'a erişim, path traversal ve yetkisiz bridge çağrısı testlerde reddedilir.
- **A5:** Import ikinci kez çalıştırıldığında duplicate oluşmaz. Hazırlanmış başvuru `drafted` kalır; otomatik `applied` sayılmaz. Kullanıcının gerçek kökü verilmemişse fixture import ve canlı import ayrı raporlanır.

## 6. MVP2 — Süreli ve otonom iş yapan uygulamalar

**Teslimat:** Agent uygulamaya background görevleri ekler; görevler UI'dan bağımsız yürür, sonuçlar kayıtlara ve ekranlara düşer. İş arama ve Berlin ev arama aynı motor üzerinde farklı pack'ler olarak çalışır.

### Todo

- [ ] M2-01 JobDefinition, JobRun, checkpoint, Action ve Activity veri şemalarını/migrations'larını tamamla. Bir run'ı app sürümüne sabitle.
- [ ] M2-02 Zamanlayıcıyı kalıcı claim/lease, başlangıç-bitiş penceresi, timezone, timeout, eşzamanlılık, tek catch-up ve kaynak sınırlarıyla uygula.
- [ ] M2-03 Run yürütücüsünü agent adımı ve sınırlı deterministic tool adımı için kur. Managed runtime'ın host secret/keychain/browser ve doğrudan dış gönderim erişimini negatif testlerle sınırla; yalnız prompt ile garanti verme. Sessiz bekleme LLM çağrısı tüketmesin; tüm tekrarlar ve araç çağrıları sınırlı olsun.
- [ ] M2-04 Servis yaşam döngüsünü UI'dan ayır; kapatma, stop ve crash recovery'yi ayrı işlemler yap. Profil sahibini PID + başlangıç kimliğiyle doğrula.
- [ ] M2-05 Pause, resume, cancel, run now ve kullanıcı girdisini bekleme işlemlerini API, MCP ve UI'da tamamla. Retry ve belirsiz dış işlem sonuçlarını görünür yap.
- [ ] M2-06 Connector sözleşmesini uygula: girdi/çıktı şeması, bağlantı gereksinimi, scope, timeout, dedup key, receipt ve reconcile davranışı. Yerel sır depoyla bağlantı referanslarını bağla.
- [ ] M2-07 Bölüm 4.5'e göre server/connector sahipli browser oturumu, üretim browser bağımlılığı, giriş bekleme, kullanıcıya kontrol devri ve devam etmeyi ekle. Agent'a raw CDP/cookie/profile yolu verme; kontrollü login kaynağıyla gerçek pencere testini geçir.
- [ ] M2-08 İş arama akışını çalıştır: keşfet/tekrar ayıkla, hızlı ele, ayrıntılı değerlendir, üret, kontrol et, düzelt, sonucu kaydet. Değerlendirme gerekçesini ve kaynaklarını koru.
- [ ] M2-09 Gerçek belge üretim zincirini doğrula: seçilen CV/cover letter şablonu, derlenmiş çıktı, dosya önizleme ve doğrulama sonucu. Kullanılmayan format araçlarını zorunlu bağımlılık yapma.
- [ ] M2-10 Berlin ev arama pack'ini aynı primitive'lerle oluştur: kriterler, ilan kaynağı, duplicate kontrolü, uygunluk, mesaj, reply/ziyaret durumları ve agent'ın ürettiği karşılaştırma ekranı.
- [ ] M2-11 HTTP/RSS, IMAP alarm ve SMTP adaptörlerini bölüm 4.5 kapsamıyla tamamla. En az bir harici canlı kaynak okunsun; kontrollü mail servisinde gerçek protokol üzerinden alma/gönderme doğrulansın. Desteklenen kaynakları açık listele; bütün portallara erişim varsayma.
- [ ] M2-12 Dış gönderimleri kalıcı action niyeti ve doğrulanmış receipt ile ilişkilendir. Gönderim sonrası bağlantı kesilmesi fixture'ında ikinci mesaj üretmeden reconcile et.
- [ ] M2-13 Süre/bütçe/işlem yetkisini backend'de denetle. Kullanıcının verdiği yetki içinde otomatik ilerle; eksik yetki veya bilgi için ilgili run'ı waiting_input yap.
- [ ] M2-14 İşlem geçmişi, son/sonraki çalışma, bulunan sonuçlar, bekleyen işler ve failures ekranlarını gerçek kayıtlara bağla. Kullanıcı sayfadan kriter değiştirebilsin.
- [ ] M2-15 Restart, sleep/catch-up, deadline, iptal, duplicate kaynak, çakışan claim ve belirsiz teslim kabul senaryolarını tamamla.

### Kabul kriterleri

- **B1:** Kullanıcı "Berlin'de kriterlerime uyan evleri yedi gün boyunca kontrol et" der. Gerçek agent gerekli kayıtları, en az bir özel sayfayı ve süreli job'ı MCP üzerinden oluşturur. Kullanıcı cron/schema yazmaz.
- **B2:** Kontrollü kaynakta yeni ilan eklendiğinde sonraki run ilanı kaydeder, uygunluğu açıklar ve verilen yetkiye göre mesaj hazırlar/gönderir. Tekrar tarama ikinci ilan veya ikinci gönderim oluşturmaz.
- **B3:** UI kapatılır; bağımsız servis bir sonraki işi tamamlar. UI yeniden açıldığında sonuç görünür. Servis crash/restart fixture'ı kalan durumu dürüstçe interrupted/reconcile olarak toparlar.
- **B4:** Hızlandırılmış saat testinde bitiş geçtikten sonra yeni run/dış gönderim başlamaz. Gerçek saatle kısa aralıkta en az iki run da gözlenir; yalnız sahte saat kanıtı yeterli değildir.
- **B5:** Gönderim gerçekleşip cevap kaybolduğunda action `unknown` olur, kör tekrar göndermez; connector sonucu doğruladığında `confirmed` olur.
- **B6:** Gerçek agent + gerçek kaynak okuma + kontrol edilen test alıcısına gerçek gönderim için ayrı kanıt vardır. İlgisiz ev sahiplerine, şirketlere veya başvuru portallarına test mesajı gönderilmez.
- **B7:** İş arama ve ev arama için domain'e özgü kod generic core'a yayılmamıştır. Agent'ın ihtiyaç önerip sayfa/job eklediği akış her iki pack'te görülür.
- **B8:** Managed agent'tan host credential/keychain/browser ve izinsiz egress erişim girişimleri reddedilir. Test alıcısındaki her teslimin bir Action kaydı ve receipt'i vardır; kayıtsız teslim başarısızlıktır. Bu audit testi tek başına OS izolasyonu kanıtı yerine geçmez.

## 7. MVP3 — Paylaşılabilir, kurulabilir ve geliştirilebilir uygulamalar

**Teslimat:** Oluşturulan uygulama sürümlü paket olarak paylaşılır, temiz profilde kurulur ve başka bilgilerle çalışır. Kullanıcı paketi özelleştirip bağımsız sürümünü paylaşabilir. Güncelleme mevcut veriyi ve devam eden işleri korur.

### Todo

- [ ] M3-01 Paket manifest'ini kesinleştir: kimlik, sürüm, gerekli platform sürümü, app şemaları, page bundle'ları, skill/prompt/tool tanımları, job tarifleri, bağlantı gereksinimleri, lisans ve kaynak bilgileri.
- [ ] M3-02 Export'u allowlist ile üret; record/artifact içerikleri, kullanıcı profil değerleri, secrets, cookie, transcript, run/action history ve makineye özgü mutlak yolları dışarıda bırak.
- [ ] M3-03 Sayfa/skill/job tanımlarına kişisel değerlerin hardcode edilmesini önleyen runtime binding ve şema/sentetik örnekle üretim akışını kur. Export privacy testinde kişisel canary değerleri ve bilinen secret değerleri aranır; tanım dosyasına gömülü veri allowlist sayesinde temizlenmiş varsayılmaz. Şüpheli içerik export'ta görünür hata verir.
- [ ] M3-04 Import'ta manifest/schema/hash/boyut/path ve dependency doğrulaması yap. Arşiv traversal/symlink saldırısı fixture'larını reddet. Paket import'u kendiliğinden kod çalıştırmasın veya gönderim başlatmasın.
- [ ] M3-05 Paket dosyasından kurulum, yerel uygulama kütüphanesi ve yeniden export deneyimini tamamla. Bir paketin farklı instance'larını kurmak mümkün olsun.
- [ ] M3-06 Kurulumda agent paketin onboarding tanımına göre kullanıcı bilgilerini toplasın, gerekli bağlantıları istesin, sayfaları hazırlasın ve kullanıcıya çalışma kapsamını göstersin.
- [ ] M3-07 Paylaşılmış uygulamanın hangi dış işlemleri yapabileceğini ve ne kadar süre çalışacağını instance ayarlarına bağla. Paket yazarının yetkileri yeni kullanıcıya taşınmasın.
- [ ] M3-08 "Kullan" ve "Kopyala/özelleştir" akışlarını uygula. Bağımsız kopya kendi paket kimliğini/sürümünü alır; upstream güncellemeleri otomatik merge edilmez.
- [ ] M3-09 Sürüm güncelleme için değişiklik özeti, veri migration dry-run, backup ve transaction'lı geçiş uygula. Devam eden run eski sürüme bağlı kalsın; yeni run yeni sürümü kullansın.
- [ ] M3-10 MVP3'te desteklenen migration türlerini sınırla: additive alan/koleksiyon ve geriye uyumlu page/job değişiklikleri. Alan silme, veri kaybettiren dönüşüm ve uyumsuz paket güncellemesini açıkça reddet; sessiz dönüştürme yapma.
- [ ] M3-11 Sürüm geri dönüşünün veriyle uyumluluğunu denetle. UI rollback'i, sonrasında yazılmış iş verisini silmesin. Uyumlu rollback ile backup restore farklı işlemler olsun.
- [ ] M3-12 İş arama ve ev arama paketlerini kaynak/lisans bilgileriyle kütüphaneye ekle; kişisel verisiz örnek girdiler ve gerekli bağlantılar açık olsun.
- [ ] M3-13 Temiz ikinci profil üzerinde export/import/onboarding/run/özelleştirme/yeni export akışını tamamla. İlk profilin sırlarına veya dosyalarına erişim olmadığını doğrula.
- [ ] M3-14 İki instance izolasyonu, başarısız migration geri dönüşü, devam eden run'ın version pin'i ve malicious package kabul testlerini geçir.
- [ ] M3-15 Kurulumdan ilk faydalı sonuca kadar tüm akışı gözden geçir: boş durumlar, hata/yeniden deneme, bağlantı kurma, durdurma, dosya açma ve terminale geçiş çalışsın.

### Kabul kriterleri

- **C1:** A profili uygulamayı export eder. B temiz profili import edip kendi kriterleriyle çalıştırır. B, A'nın kayıtlarını, belgelerini, credential veya tarayıcı oturumlarını görmez.
- **C2:** B "Berlin yerine Hamburg için düzenle, karşılaştırmaya ulaşım notu ekle" dediğinde agent bir kopyayı değiştirir. A'nın uygulaması değişmez; B kendi paketini yeniden paylaşabilir.
- **C3:** Yeni additive sürüm kurulduğunda eski kayıtlar korunur. Çalışan run eski sürümü tamamlar; sonraki run yeni sürümle başlar. Başarısız migration aktif sürümü değiştirmez.
- **C4:** Paket dosyası tek başına taşınabilir: geliştiricinin checkout'una, kişisel absolute path'lerine veya TermLoop Project/Task kimliğine ihtiyaç duymaz. Uyumlu Agent Apps runtime ve bildirilen araç bağımlılıkları yeterlidir.
- **C5:** Aynı paket iki instance'da paralel çalışırken sorgular, dosyalar, events, jobs ve dış işlemler birbirine karışmaz.

Upgrade mekanizması: instance'ın `active_version_id` ve `pending_version_id` alanları ayrı olur. İzinli additive diff doğrulanır, mevcut kayıtlar yeni şemaya dry-run edilir; snapshot/backup sonrası active pointer transaction içinde değişir. Referansı olan eski sürüm silinmez. Paket güncellemesiyle eklenen job'lar paused gelir; mevcut yetkiyi kendiliğinden genişletmez.

Her kayıt `written_under_version_id` taşır. Eski run/eski sayfa pinned sürümünün alan görünümünü okur; yazma işlemleri yalnız yetkili alanları merge/CAS ile değiştirir ve daha yeni alanları silmez. `additionalProperties: false` olan eski şemaya bütün yeni kaydı verip "additive zaten uyumludur" varsayımı yapılmaz. Rollback öncesi gerçek read/write uyumluluğu kontrol edilir; güvenli değilse reddedilir. Fork yeni package kimliği ve `forked_from` referansı alır; otomatik upstream merge yoktur.

## 8. Kanıt, test ve tamamlanma

### Komut sözleşmesi

Aşağıdaki `agent-apps:*` komutları bugün mevcut değildir; bu goal içinde eklenmeleri gereken kalıcı arayüzdür. Gerçek paket adları bu belgede belirtilen sınırlarla uyumlu seçilir ve komutlar tek yerden yönetilir.

| Komut | Beklenen kapsam |
| --- | --- |
| `pnpm agent-apps:dev` | İzole profil ile build + bağımsız servis + masaüstü; hazır olma durumunu doğrular. |
| `pnpm agent-apps:status` / `pnpm agent-apps:stop` | Yalnız verilen ürün/profilin süreçlerini sorgular/durdurur. |
| `pnpm agent-apps:check` | Yeni ürün type-check, schema drift, format ve mimari sınırlar. |
| `pnpm agent-apps:test` | Domain/store/runner/bridge/package testleri ve deterministic fixture E2E. |
| `pnpm agent-apps:acceptance -- --stage mvp1` | A1–A5; gerçek agent kanıtını fixture'lardan ayrı raporlar. |
| `pnpm agent-apps:acceptance -- --stage mvp2` | B1–B8; gerçek saat ve kontrollü gerçek connector kanıtları. |
| `pnpm agent-apps:acceptance -- --stage mvp3` | C1–C5; temiz profil ve paket taşınabilirliği. |

Repo hazırlığı: `pnpm install --frozen-lockfile`, ardından `pnpm codegen`. Yeni bağımlılık eklendiğinde lockfile normal şekilde güncellenir; frozen install teslim edilen lockfile'ın doğrulamasıdır.

İterasyonda yerel testler ve etkilenen crate/paket kontrolleri çalıştırılır. Teslimat çok modüllü/schema/build değişikliği içerdiğinden final entegre durumda `pnpm check` ve `pnpm test` zorunludur. Başarılı, değişmeyen geniş kontrol gereksiz tekrarlanmaz. Ana uygulamanın testi için mevcut `tools/dev/AGENTS.md` kurallarına uyulur; yeni ürünün başlatıcısı ayrı isim ve profile sahiptir.

### Kanıt tablosu

| Kapı | Sonuç | Komut / kanıt yolu | Eksik veya ölçülmeyen |
| --- | --- | --- | --- |
| MVP1 A1–A5 | Bekliyor | — | Tümü |
| MVP2 B1–B8 | Bekliyor | — | Tümü |
| MVP3 C1–C5 | Bekliyor | — | Tümü |
| Final `pnpm check` | Bekliyor | — | Çalıştırılmadı |
| Final `pnpm test` | Bekliyor | — | Çalıştırılmadı |
| Mevcut TermLoop regresyon kontrolü | Bekliyor | — | Çalıştırılmadı |
| Commit/push ve remote eşitliği | Bekliyor | — | Uygulama teslimi başlamadı |

Gerçek agent veya connector testi yapılamıyorsa fixture başarısı onun yerine yazılmaz. Kimlik bilgisi/ağ/üçüncü taraf erişimi gibi dış engel açıkça raporlanır; bağımsız işler sürdürülür. Gerekli gerçek kabul kanıtı eksikken goal tamamlandı denmez. Kullanıcıya özel mevcut arşiv verilmemesi generic import fixture testini engellemez; özel arşiv testi ayrıca ölçülmeyen olarak yazılır.

Her acceptance koşusu `work/evidence/agent-apps/<stage>/<run-id>/report.json` üretir. Kriter başına `mode: fixture | live`, `status: pass | fail | blocked`, commit/app sürümü, provider/model, başlangıç-bitiş, sınırlar, blocker ve artifacts bulunur. Artifacts: redakte MCP çağrı kaydı, UI ekran görüntüsü, run/action kimlikleri, teslim receipt'i ve gerekiyorsa test alıcısı message-id'si. Bu özel evidence dizini Git'e ve paylaşılan pakete eklenmez; raporlar secret/kişisel metin içermez.

Canlı kanıt zorunlu kapılar: A1, A3, B1, B4'ün gerçek saat bölümü ve B6. C1/C2 temiz profil kurulumu, gerçek UI etkileşimi ve gerçek agent özelleştirmesiyle çalıştırılır. Diğer kapılar hedeflediği özelliğe göre gerçek runtime fixture'larıyla geçilebilir; mode dürüstçe belirtilir. Gerçek agent, önceki kullanıcı tercihinden seçilir; model/bütçe/timeout raporlanır, sınırsız deneme yapılmaz. Provider gerçek maliyeti bildirmiyorsa uydurma maliyet gösterilmez; çağrı/dakika sınırı yine backend'de uygulanır.

Deterministik testler kaydedilmiş ve anonimleştirilmiş MCP transkriptlerini replay edebilir. Bu platform kontratını kanıtlar; yeni boş instance'da canlı agent'ın kendi sayfa/job oluşturduğu kanıtın yerine geçmez. Commit/CI kontrolleri deterministic kalır; canlı acceptance ayrı komuttur ama goal'ün required kabul kapısıdır.

### Claude Fable ile mimari değerlendirme

Claude Fable ile iki tur tartışıldı. İlk küçük, tarayıcı ağırlıklı öneri kullanıcının üç büyük MVP talebine göre yeniden değerlendirildi. Son incelemede ayrı ürün/domain/store, masaüstü, schema-first contract, gerçek agent kanıtı ve üç büyük teslimat üzerinde uzlaşıldı. Buraya yansıtılan düzeltmeler: açık DAG/launch/network sahipliği, action bypass sınırı, taslak dosya/snapshot ilişkisi, üretim browser sahipliği, MessageChannel izolasyonu, fixture/live evidence ayrımı ve veri koruyan sürüm geçişi.

Fable'ın ek önerileri bağlayıcı onay ihtiyacı sayılmadı. Bu planın açık mimari dilimleri gerekli tooling değişikliklerini yetkilendirir. MVP başına checkpoint commit önerisi seçilmedi: kullanıcı mevcut baseline commit/push istedi; yeni ürün teslimatında kök git kuralına göre tamamlanan üç aşamanın değişiklikleri tek teslimat olarak commit/push edilir. Arada checkpoint commit ancak kullanıcının ayrıca açık talebiyle yapılır.

### Final teslim koşulları

- [ ] D-01 Üç MVP'nin bütün zorunlu kutuları ve kabul kapıları kanıtla tamamlandı.
- [ ] D-02 Boş kullanıcıdan çalışan uygulamaya, zamanlanmış işten sonuca ve export'tan bağımsız kuruluma gerçek akışlar doğrulandı.
- [ ] D-03 UI'da çalışmayan buton, sahte başarı durumu veya doldurulmuş demo verisinin gerçek veri gibi sunulması yok.
- [ ] D-04 İlgisiz/pre-existing değişiklikler korundu; yalnız bu teslimata ait değişiklikler seçildi.
- [ ] D-05 Gerekli final kontroller geçti; başarısızlıkların tam tanıları ve skipped/unmeasured durumları kaydedildi.
- [ ] D-06 Root AGENTS git akışına göre tamamlanmış teslimat commit edildi, push öncesi origin fetch edildi, gerekirse remote ilerleme entegre edilip orantılı doğrulama tekrarlandı; develop force-push yapılmadı.
- [ ] D-07 Push sonrasında yerel develop/origin develop eşitliği ve bu teslimattan uncommitted değişiklik kalmadığı doğrulandı. Main/release/publish ayrı açık kullanıcı talebi olmadan yapılmadı.
- [ ] D-08 Son yanıt değişen sınırları, komut/sonuçları, kanıtları, kalan sınırları ve uygulamanın nasıl açılacağını içeriyor.

## 9. Kopyalanabilir goal talimatı

> Önce `docs/agent-apps-idea.md`, ardından `docs/agent-apps-mvp-plan.md` dosyalarını oku. Agent Apps ürününü MVP1, MVP2 ve MVP3 dahil tek bir tamamlanmış teslimat olarak uygula. İlk ürün kodundan önce bu görüşmede istenen mevcut yerel değişikliklerin commit/push checkpoint'inin hazır olduğunu doğrula. Kullanıcının amacından gerekli veri, sayfa ve background görevlerini agent'ın oluşturduğu; iş arama ve Berlin ev arama paketlerinin aynı motoru kullandığı; uygulamaların kişisel verilerden ayrı paketlenip başka profilde kurulabildiği gerçek ürünü tamamla. Belgedeki mimari sınırları, kapsam varsayımlarını, kabul kriterlerini ve test/kanıt sözleşmesini esas al. Sıradan uygulama kararlarını kendin çöz; yalnız gerçekten eksik hesap/kimlik bilgisi veya kullanıcıya ait karar için sor, bağımsız işi sürdür. Kutuları yalnız doğrulanan sonuçlarla işaretle, üç aşama bitmeden goal'ü tamamlanmış sayma. Mevcut ve eşzamanlı değişiklikleri koru. Gerekli kontrolleri geçir; repo kurallarına göre yalnız bu teslimatı commit/push et ve sonucu doğrula. Main'e entegrasyon veya harici yayın yapma.
