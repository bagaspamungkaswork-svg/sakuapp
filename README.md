# SaKu — aplikasi Android dan iOS

Proyek ini membungkus aplikasi web SaKu (*Simpan, Anggaran, Keluar-masuk, Uang*) (edisi Firebase; konfigurasi Firebase diisi saat build dari variabel repositori, tidak disimpan di repo) menjadi aplikasi Android dan iOS memakai [Capacitor](https://capacitorjs.com). Satu isi aplikasi yang sama berjalan di web, Android, dan iOS.

> **Status:** proyek ini **belum pernah dikompilasi** oleh pembuatnya. Lingkungan tempat ia dibuat tidak punya Android SDK maupun Xcode. Yang sudah diuji hanyalah bagian web (termasuk mode aplikasi dengan Capacitor tiruan). Kalau build pertama gagal, salin pesan galatnya ke Claude supaya diperbaiki.

## Isi folder

| Berkas | Fungsi |
|---|---|
| `www/` | Aplikasi web yang akan dibungkus (hasil build edisi Firebase) |
| `capacitor.config.json` | Nama aplikasi (`SaKu`), ID paket (`id.saku.keuangan`), warna latar |
| `assets/` | Logo SaKu: ikon (latar putih) dan layar pembuka terang/gelap, diubah otomatis ke semua ukuran |
| `scripts/patch-native.sh` | Menambah izin kamera dan foto (untuk foto struk) ke proyek native |
| `.github/workflows/build-mobile.yml` | Membangun APK Android (dan uji bangun iOS) di cloud GitHub |

Folder `android/` dan `ios/` sengaja tidak disertakan; keduanya dibuat otomatis oleh `npx cap add`.

## Android — cara termudah: bangun di GitHub (tanpa Android Studio)

1. Buat akun GitHub (gratis) lalu buat repositori baru, sebaiknya **Private**.
2. Unggah **seluruh isi** folder ini ke repositori (Add file → Upload files). Jika folder `.github` tidak ikut terunggah (sering terjadi dari HP), pilih Add file → Create new file, ketik nama `.github/workflows/build-mobile.yml`, lalu tempel isi berkas `SALIN-KE-.github-workflows-build-mobile.yml`.
3. Buka tab **Actions** → pilih **Bangun Aplikasi Mobile** → **Run workflow**.
4. Tunggu sekitar 10–15 menit sampai `Android (APK)` centang hijau. Buka eksekusinya, lalu unduh artefak **saku-android-apk** (berupa zip berisi `app-debug.apk`).
5. Ekstrak zip, pindahkan `app-debug.apk` ke HP, buka, dan izinkan "Pasang dari sumber tidak dikenal" bila diminta.

APK ini bertanda tangan kunci *debug*: cukup untuk dipakai sendiri atau dibagikan ke orang lain secara langsung. Untuk Google Play Store dibutuhkan build rilis dengan kunci tanda tangan milik Anda (belum disiapkan di proyek ini).

## Android — di laptop dengan Android Studio

Butuh Node.js 22, JDK 21, dan Android Studio.

```bash
npm install
npx cap add android
bash scripts/patch-native.sh android
npx capacitor-assets generate --android
npx cap sync android
npx cap open android      # lalu Build > Build APK(s), atau Run di HP
```

## iOS

Apple mewajibkan **Mac dengan Xcode** untuk membangun aplikasi iPhone. Untuk memasangnya di iPhone sungguhan juga butuh Apple ID (gratis, aplikasi kedaluwarsa tiap 7 hari) atau Apple Developer Program (US$99 per tahun, untuk TestFlight dan App Store).

```bash
npm install
npx cap add ios
bash scripts/patch-native.sh ios
npx capacitor-assets generate --ios
npx cap sync ios
npx cap open ios          # di Xcode: pilih Team di Signing & Capabilities, lalu Run
```

Alur kerja GitHub juga punya tugas `iOS (uji bangun simulator)` yang hanya memastikan proyek bisa dikompilasi untuk simulator. Hasilnya **tidak bisa dipasang di iPhone** karena tidak bertanda tangan.

**Tanpa Mac:** buka alamat situs SaKu di Safari iPhone → tombol Bagikan → **Tambah ke Layar Utama**. Hasilnya tampil seperti aplikasi, tanpa biaya.

## Masuk dengan Google di aplikasi Android (opsional)

Tombol "Masuk dengan Google" di aplikasi hanya dipasang bila Anda menyediakan **Web Client ID** Google. Tanpa itu, APK dibangun seperti biasa dan tombolnya tidak muncul.

1. Di Google Cloud Console (proyek yang sama dengan Firebase Anda) buat dua **OAuth client ID**: satu bertipe **Web application** (salin Client ID-nya) dan satu bertipe **Android** dengan nama paket `id.saku.keuangan` dan sidik jari SHA-1 kunci tanda tangan SaKu: `FB:5E:06:5A:DC:83:8B:A7:0C:97:8E:AC:B6:CC:11:DF:02:87:1F:D1`.
2. Di GitHub: **Settings → Secrets and variables → Actions → Variables → New repository variable**, nama `GOOGLE_WEB_CLIENT_ID`, isi Web Client ID tadi.
3. Jalankan ulang workflow. Bila plugin Google gagal dikompilasi, workflow otomatis membangun ulang tanpa plugin supaya rilis tetap terbit.
4. Di Firebase Console aktifkan **Authentication → Sign-in method → Google**, dan terbitkan ulang `firestore.rules` dari paket `saku-firebase`.

Untuk mengujinya tanpa merilis, jalankan workflow secara manual dari cabang lain dan isi kolom "google_web_client_id"; rilis hanya diterbitkan dari cabang `main`/`master`.

## Memperbarui isi aplikasi

Ganti isi folder `www/` dengan hasil build web terbaru (dari paket `saku-firebase`, tanpa `_headers`, `firestore.rules`, dan `sw.js`), lalu bangun ulang. Di laptop cukup `npx cap sync`.

Untuk edisi **statis** (data hanya di perangkat, tanpa server), isi `www/` dengan paket `saku-statis`. Edisi Netlify tidak cocok dibungkus karena membutuhkan server Netlify.

## Yang perlu diketahui

- **Unduhan di dalam aplikasi:** cadangan data, Laporan PDF, Excel, dan CSV dibuka lewat lembar bagikan sistem (Simpan ke Berkas, Drive, WhatsApp, dan lainnya), karena WebView tidak mendukung tautan unduh biasa. Bagian ini sudah diuji dengan Capacitor tiruan, belum di perangkat sungguhan.
- **Kunci API Firebase:** jika di Google Cloud Anda membatasi kunci API ke domain situs tertentu (HTTP referrer), aplikasi akan ditolak. Tambahkan `https://localhost/*` (Android) dan `capacitor://localhost/*` (iOS) ke daftar yang diizinkan, atau gunakan kunci tanpa pembatasan aplikasi.
- **Internet:** edisi Firebase butuh internet untuk masuk dan menyimpan. Font tampilan dimuat dari Google Fonts; tanpa internet aplikasi memakai font bawaan sistem.
- **Tepi layar:** poni kamera dan bilah navigasi ditangani lewat `env(safe-area-inset-*)`. Jika ikon bilah status sulit terbaca di versi Android tertentu, itu perlu disetel (`@capacitor/status-bar`).
- **Versi:** proyek memakai Capacitor 7. Jika `npm install` mengambil versi yang lebih baru dan ada perintah yang berubah, tetapkan versi di `package.json`.
