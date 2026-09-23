# Agent Apps — ürün fikri ve amaç

Tarih: 23 Eylül 2026. `Agent Apps` geçici çalışma adıdır.

Bu dosya fikri, kullanıcı ihtiyacını ve hedef deneyimi açıklar. Uygulama sırası, teknik kararlar ve tamamlanma kriterleri [üç MVP planındadır](agent-apps-mvp-plan.md). İkisi birlikte, önceki konuşmayı bilmeyen bir geliştiricinin veya agent'ın işi devralabilmesi için yazılmıştır.

## Fikir

Kullanıcı yapmak istediği işi anlatır. Agent bu işi yürütmek için gereken küçük uygulamayı oluşturur: kayıtları, dosyaları, ekranları, araç bağlantılarını ve arka plan görevlerini kurar. Sonra bu uygulamanın içinde çalışmayı sürdürür. Kullanıcı sonuçları ekranda görür, gerektiğinde agent'la konuşur, kriterleri değiştirir ve işi durdurur veya uzatır.

Oluşturulan uygulama paylaşılabilir. Başka biri kendi bilgileri, hesapları ve verileriyle kullanabilir; kopyalayıp değiştirebilir ve kendi sürümünü paylaşabilir.

Örnek istek:

> Berlin'de sıcak kirası 1.500 avronun altında, en az iki odalı bir ev arıyorum. Wedding ve Moabit olabilir. Önümüzdeki yedi gün yeni ilanları takip et, kriterlerime uyanlara verdiğim bilgilerle mesaj yaz ve cevapları takip et.

Agent şu tür bir öneriyle işi kurar:

> İlanları ve yazışmaları ayrı kaydedeceğim. Evleri karşılaştırabileceğin bir sayfa, mesajları görebileceğin bir ekran ve yarım saatte bir kontrol görevi oluşturuyorum. Mesaj yazmak için henüz eksik olan bilgilerini de tamamlayalım.

Kullanıcı bu örnekte tablo yapısını, sayfa sayısını veya görevin teknik tanımını tasarlamaz. Bunları ihtiyaca göre agent önerir ve oluşturur.

## Nereden çıktı?

Ferit, iş arama ve başvuru hazırlığı için güçlü coding agent'lar ve [ai-job-search](https://github.com/MadsLorentzen/ai-job-search) projesini kullanıyor. Agent ilan inceliyor, kullanıcıyı tanıyor, CV ve cover letter hazırlıyor, dosya üretiyor ve değerlendirme yapıyor.

Günlük kullanımda ihtiyaç duyulan devamlılık şu sorularda ortaya çıkıyor:

- Hangi ilanlara baktık? Hangileri elendi ve neden?
- Hangi başvuru yalnız hazırlandı, hangisi gerçekten gönderildi?
- Bu şirkete hangi CV ve cover letter sürümü kullanıldı?
- Agent şu anda ne yapıyor? Benden ne bekliyor?
- Yarın veya gelecek hafta bu iş nasıl devam edecek?
- Aynı düzeni başka biri nasıl kuracak?

Referans projenin mevcut sürümünde tracker dosyaları, arşivler, HTML raporu ve Notion görünümü var. Bizim hedefimiz bunları örnek alan; canlı veri, etkileşimli ekran, süreli çalışma ve paylaşılabilir uygulama yaşam döngüsünü birlikte sağlayan genel bir ürün.

## Kim kullanır?

### Kendi işini düzenlemek isteyen kişi

İş başvurusu, ev arama, araştırma, içerik hazırlama veya başka bir tekrar eden iş için kendi uygulamasını oluşturur. İster sadece kayıtlarını takip eder, ister agent'a belirli işlemleri yürütme yetkisi verir.

### Hazır bir uygulamayı kullanmak isteyen kişi

Bir başkasının oluşturduğu uygulamayı kurar. Agent gerekli bilgileri sorar; kullanıcı kendi hesaplarını bağlar ve kapsamını belirler. Uygulama onun için çalışır.

### İş akışı oluşturup paylaşan kişi

Kendi deneyimiyle geliştirdiği talimatları, araçları, ekranları ve otomasyonları paketler. Örneğin iyi çalışan bir iş arama düzeni veya ev arama asistanı paylaşır. Kullanıcıların kişisel verileri bu paketin parçası olmaz.

Bu roller arasında geçiş kolay olmalıdır: hazır uygulamayı kullanan kişi "buna ziyaret notları ekle" diyerek kendi sürümünü oluşturmaya başlayabilir.

## Temel kullanıcı deneyimi

1. **Amacını anlatır.** Kullanıcı neyi başarmak istediğini ve bildiği kısıtları söyler.
2. **Agent ihtiyacı şekillendirir.** Elindeki dosyaları ve izin verilen kaynakları değerlendirir; yalnız gerekli eksik bilgileri sorar. Oluşturacağı ekranları ve görevleri anlaşılır biçimde anlatır.
3. **Uygulama oluşur.** Veri yapıları ve sayfalar gerçek kayıtlara bağlıdır. Dosyalar ilgili işe bağlanır; görevler görünür olur.
4. **İş yürür.** Agent gerektiğinde araç kullanır, kayıtları günceller, çıktı üretir ve tanımlanmış zamanda tekrar çalışır.
5. **Kullanıcı yön verir.** Ekrandan bir kaydı açar, belgeyi inceler, bir paragraf için değişiklik ister veya tüm aramanın kriterlerini değiştirir.
6. **Uygulama gelişir.** Agent yeni bir ihtiyaç gördüğünde sayfa veya görev önerebilir. Değişiklikler mevcut verileri ve devam eden işleri korur.
7. **İş durur, bilgi kalır.** Süre dolduğunda veya kullanıcı durdurduğunda otomasyon durur. Kayıtlar, belgeler ve sonuçlar daha sonra açılabilir.
8. **Uygulama paylaşılır.** İşe yarayan düzen kişisel bilgilerden ayrılmış paket olarak başka bir kurulumda kullanılabilir.

Kullanıcının her adımı yeniden onaylaması amaçlanmaz. Başta verdiği kapsam ve yetkiler içinde iş devam eder. Yeni hesap bağlantısı, kapsam dışı bir işlem veya gerçekten eksik bilgi varsa ilgili adım kullanıcı girdisini bekler.

## Ekranlar nasıl olacak?

Uygulamanın dış kabuğu tutarlıdır: uygulama seçimi, agent'a erişim, dosyalar, görev durumu ve bildirimler bulunur. İşe özel içerik ve düzen agent tarafından oluşturulur.

- İş başvurusunda: başvuru panosu, şirket detayı, CV/cover letter önizlemesi, görüşme hazırlığı.
- Ev aramada: ilan kartları, karşılaştırma, gerekirse harita, yazışmalar ve ziyaret notları.
- Araştırmada: kaynak listesi, karşılaştırmalar, notlar ve zaman içinde eklenen bulgular.

Bu ekranlar çalışan veriye bağlı uygulama sayfalarıdır. Bir düğme gerçek bir kayıt değişikliği veya tanımlı eylem başlatır. Kullanıcı isterse agent terminalini de açabilir, devam eden işi inceleyebilir ve doğrudan konuşabilir.

Örnek: kullanıcı bir başvurunun cover letter'ını açar, bir paragrafı seçer ve "burada şu projemi öne çıkar" der. Agent doğru başvuru ve dosya sürümüyle çalışır; yeni sürüm aynı kayıtta görünür.

## İş arama referansını nasıl genelleştireceğiz?

Referans repo; talimatlar, skills, yardımcı araçlar ve dosyalardan oluşan iyi tanımlanmış bir çalışma düzeni sunuyor. Güçlü tarafları korunacak:

- Kullanıcı hakkında doğrulanmış bilgi toplamak.
- Zorunlu koşullarla tercihleri ayırmak.
- Önce hızlı eleme, sonra seçilen sonuçlar için ayrıntılı çalışma yapmak.
- Çıktı üretmek, uygun kontrolü yapmak ve gerekiyorsa düzeltmek.
- Sonucu, kullanılan dosyaları ve yapılan işlemleri kaydetmek.

İşe özgü uzmanlık paketlerde kalır. İş arama paketi CV ve başvuru hazırlığını bilir; ev arama paketi ilan kriterlerini ve mesajlaşma sürecini bilir. Genel motor kayıt, dosya, sayfa, görev, işlem ve paylaşım kavramlarını bilir.

Her iş aynı zorunlu altı aşamalı akışa sokulmaz. Agent hazır paketleri ve yetenekleri kullanarak ihtiyaca uygun adımları kurabilir. Basit bir fiyat kontrolü için ikinci bir reviewer agent veya belge üretimi zorunlu değildir.

## TermLoop'un rolü

TermLoop, bu ürünün agent çalıştırma deneyimi için başlangıç noktasıdır. Terminal/süreç yönetimi, oturumlara bağlanma, provider durum olayları ve bazı platform yetenekleri yeniden kullanılabilir.

Yeni ürünün uygulama tanımları, iş kayıtları, dosya ilişkileri, background görev geçmişi ve paylaşım modeli ayrı sorumluluklardır. Bunların TermLoop'un Git/Task işleyişine bağlı olması amaçlanmaz. Kullanıcı bir ev arama uygulaması kurmak için Git branch veya worktree bilmemelidir.

Yerleşim varsayımı aynı monorepoda ayrı uygulamadır. Kaynak kodunun ortak repoda olması, kullanıcıların aynı veritabanını veya aynı çalışan uygulamayı paylaşması anlamına gelmez.

## Background çalışma ne demek?

Agent "bu işi her yarım saatte bir yapacağım" dediğinde kalıcı bir görev oluşturur. Sürekli açık bir konuşmanın hatırlamasına güvenilmez. Çalıştırıcı, zamanı gelince gerekli kodu veya agent adımını başlatır; sonucu kaydeder ve ekrana bildirir.

Görevlerin başlangıç/bitiş zamanı, sonraki çalışması, durumu ve son sonucu görülebilir. Kullanıcı duraklatabilir, iptal edebilir veya süresini değiştirebilir. Aynı ilana tekrar yazılmaması ve bağlantı kopunca sonucun belirsiz kalabilmesi çalışma modelinde açıkça ele alınır.

İlk üç MVP'de arayüz kapalı olsa da makine açıkken bağımsız yerel servis çalışır. Bilgisayar kapalıyken devam eden hosted/uzak çalıştırma daha sonraki bir kapsamdır. Bağlantı kesilmesi veya oturum açma ihtiyacı saklanmaz; ilgili işin durumu görünür olur.

## Paylaşılabilir olan nedir?

Paylaşılan uygulama paketi şunları içerir:

- İşin nasıl yapılacağını anlatan talimatlar ve skills.
- Veri yapılarını ve ekranları tanımlayan içerik.
- Görev ve araç tanımları.
- Kurulumda sorulacak bilgi türleri ve gerekli bağlantılar.
- Sürüm, bağımlılık ve kaynak bilgileri.

Kişisel profil değerleri, bulunan ilanlar, başvurular, belgeler, yazışmalar, tarayıcı oturumları ve hesap sırları pakete dahil değildir.

İlk sürümde paylaşım paket dosyasını başka kurulumda açmakla çalışır. Hazır uygulamayı kullanmak ve kendi kopyasını oluşturup değiştirmek desteklenir. Ortak canlı çalışma alanı, herkese açık katalog, ücretli satış ve otomatik fork birleştirme sonraki olasılıklardır.

## Üç büyük teslimat

| Aşama | Kullanıcıya kazandırdığı |
| --- | --- |
| **MVP1 — Uygulama oluşturma** | Agent ihtiyaca göre gerçek veri yapıları ve ekranlar oluşturur. Kayıt, belge ve terminal aynı çalışma alanında kullanılır. |
| **MVP2 — Otonom işletim** | Agent süreli background işler kurar; iş arama ve ev arama akışları sonuç üretir, değişiklikleri ve belirsizlikleri görünür tutar. |
| **MVP3 — Paylaşım ve gelişim** | Uygulama kişisel veriler olmadan taşınır, yeni kullanıcı için kurulur, özelleştirilir ve veri koruyan sürüm güncellemeleri alır. |

Bu üçü tek goal'ün kapsamıdır. Birbirlerinden bağımsız üç ürün yapılmayacak.

## Neyi amaçlıyoruz?

- Kullanıcının ihtiyaç duyduğu aracı konuşarak oluşturabilmesi.
- Agent'ın yaptığı işin ve ürettiği dosyaların kalıcı, anlaşılır ve yönetilebilir olması.
- Tekrar eden işlerin belirlenen süre ve kapsam içinde sürdürülebilmesi.
- Kullanıcının kullandıkça uygulamayı değiştirebilmesi.
- Bir kişinin işe yarayan düzeninin başkaları tarafından da kurulabilmesi.
- Farklı işlerin aynı altyapı üzerinde, kendi uzmanlıklarını koruyarak çalışması.

## Başarıyı nasıl anlayacağız?

Kullanıcı "şöyle bir işim var" dedikten sonra elle kod, schema veya cron yazmadan çalışan bir uygulama elde eder. Oluşan sayfalarda gerçek verisini görür; agent'ın yaptığını ve kendisini bekleyen işleri anlayabilir. Uygulama kapatılıp açıldığında bilgiler kaybolmaz. Süreli işler doğru zamanda çalışır ve durur. Aynı uygulama başka temiz profilde, ilk kullanıcının verileri taşınmadan kurulabilir.

İş arama ve ev arama senaryolarının ikisinin de aynı altyapıda çalışması, genel ürün fikrinin kabul kanıtıdır. Teknik kanıtlar, checkbox'lar ve goal metni [MVP planında](agent-apps-mvp-plan.md) bulunur.
