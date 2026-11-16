#!/usr/bin/env bash
# Menambal proyek native yang dibuat `npx cap add <platform>`: izin kamera/foto untuk fitur foto struk.
# Pakai: bash scripts/patch-native.sh android   |   bash scripts/patch-native.sh ios
set -euo pipefail
platform="${1:-}"
case "$platform" in
  android)
    f="android/app/src/main/AndroidManifest.xml"
    [ -f "$f" ] || { echo "Tidak ada $f. Jalankan 'npx cap add android' dulu." >&2; exit 1; }
    if ! grep -q 'android.permission.CAMERA' "$f"; then
      sed -i.bak 's#<uses-permission android:name="android.permission.INTERNET" */>#&\n    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />#' "$f"
      rm -f "$f.bak"
    fi
    grep -q 'android.permission.CAMERA' "$f" || { echo "Gagal menambah izin kamera ke $f" >&2; exit 1; }
    echo "Android: izin kamera ditambahkan."
    ;;
  ios)
    p="ios/App/App/Info.plist"
    [ -f "$p" ] || { echo "Tidak ada $p. Jalankan 'npx cap add ios' dulu." >&2; exit 1; }
    pb=/usr/libexec/PlistBuddy
    [ -x "$pb" ] || { echo "PlistBuddy hanya ada di macOS." >&2; exit 1; }
    set_key() { "$pb" -c "Delete :$1" "$p" >/dev/null 2>&1 || true; "$pb" -c "Add :$1 string $2" "$p"; }
    set_key NSCameraUsageDescription "Kamera dipakai untuk memotret struk belanja."
    set_key NSPhotoLibraryUsageDescription "Galeri dipakai untuk memilih foto struk."
    set_key NSPhotoLibraryAddUsageDescription "Menyimpan foto struk ke galeri."
    echo "iOS: keterangan izin kamera dan foto ditambahkan."
    ;;
  *) echo "Pakai: bash scripts/patch-native.sh android|ios" >&2; exit 1 ;;
esac
