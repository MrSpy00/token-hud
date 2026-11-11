# Token HUD — BetterGravity Plugin

Antigravity (BetterGravity) başlık çubuğunda canlı bağlam/token göstergesi.
Uygulamanın kendi göstergesi yalnızca yüzde verir; Token HUD'un altında
ne yattığını ve oturumun gerçek maliyet/kapasite durumunu gösterir.

> Tüm veriler Antigravity sunucusunun gönderdiği gerçek değerlerden okunur
> (tahmin/sanılmaz). Plugin salt okunurdur; yalnızca kendi DOM'unu ekler ve
> dispose'ta temizler.

![versiyon](https://img.shields.io/badge/version-1.0.0-blue)
![lisans](https://img.shields.io/badge/license-MIT-green)

## Özellikler

- **Başlık çubuğu chip'i** — native görünümlü mini ilerleme halkası + kullanım
  yüzdesi (yeşil < %50, sarı < %80, kırmızı ≥ %80). Tıkla → aç, tekrar tıkla →
  kapat; açık/kapalı durumu hatırlanır.
- **Bağlam paneli** (tek sayfa, kaydırmasız):
  - Kullanım %, bağlam limiti (aktif), toplam token ve token dağılımı
    (System Prompt / Tools / Chat Messages / Unspecified / ...)
  - Model + model ID, kalan kota ve kota sıfırlama zamanı
  - Kullanıcı mesajı / asistan yanıtı / adım / kompaksiyon sayıları
  - **Input / Output / Thinking / Cache token toplamları** — her adımın
    `modelUsage` verisinden toplanır (sunucu gerçeği)
  - İlk mesaj / son aktivite zamanları (adım timestamp'lerinden)
  - Maliyet (yalnızca ücretli planda `costSummary` gelirse görünür)
- Uzun konuşmalarda adım dilimi kısmi yüklendiyse sayılar `*` ile işaretlenir
  ve tooltip'te "yüklü: n/toplam" belirtilir — eksik veri asla tam sayı gibi
  gösterilmez.

## Veri kaynağı

React fiber ağacından cascade context provider'ına
(`agentStateProvider + selectedModel`) ulaşılır ve `provider.getState()`
1 sn aralıklarla okunur:

- `contextWindowUsage` — aktif bağlam penceresi (sunucu ataması), tahmini
  kullanım, token grubu dağılımı
- `trajectorySlice.stepsInSlice[].metadata.modelUsage` — adım bazlı gerçek
  token sayaçları (int64 → Number dönüşümü bigint-güvenli yapılır)
- `turns`, `compactionInfo`, `costSummary`, `quotaInfo` — oturum/turn/kota
  bilgisi

Kullanım yüzdesi, Antigravity'nin kendi göstergesiyle aynı değer üzerinden
hesaplanır: sunucunun o oturuma atadığı `maxContextTokens` (örn. 256.000).
Modelin teorik limiti (örn. 1M) bundan yüksek olabilir; seçenekler
istemciye gönderilmediği için gösterilen değer "aktif pencere"dir.

## Kurulum

1. BetterGravity plugin klasörüne klonla:

   ```sh
   git clone https://github.com/MrSpy00/token-hud.git "C:\Users\mrSpy\AppData\Roaming\BetterGravity\plugins\token-hud"
   ```

2. Antigravity'yi yeniden başlat (veya plugin'leri yeniden yükle).

## Dosyalar

| Dosya | Amaç |
| --- | --- |
| `plugin.json` | BetterGravity manifest'i |
| `index.js` | Eklenti kodu (fiber taraması, 1 sn poll, chip + panel) |
| `styles/hud.css` | Kapsamlı stiller (tbgh-* öneki, uygulama CSS'ine dokunmaz) |

## Lisans

[MIT](LICENSE) © MrSpy00 (aegisSoft)
