#!/usr/bin/env bash
# Menambah "Masuk dengan Google" native ke proyek Android hasil `npx cap add android`.
# OPSIONAL: hanya dipanggil workflow bila variabel repositori GOOGLE_WEB_CLIENT_ID diisi. Tanpa itu aplikasi dibangun seperti biasa.
# Pakai: bash scripts/patch-google-native.sh android
# Berhasil: plugin @capgo/capacitor-social-login terpasang dan MainActivity.java menyambungkannya. MainActivity asli disimpan sebagai
# MainActivity.java.orig supaya workflow bisa memulihkannya bila kompilasi gagal.
set -euo pipefail
[ "${1:-}" = "android" ] || { echo "Pakai: bash scripts/patch-google-native.sh android" >&2; exit 1; }

main=$(find android/app/src/main/java -name MainActivity.java 2>/dev/null | head -1 || true)
[ -n "$main" ] || { echo "MainActivity.java tidak ditemukan. Jalankan 'npx cap add android' dulu." >&2; exit 1; }
pkg=$(grep -m1 '^package ' "$main" | sed -E 's/^package ([^;]+);.*/\1/')
[ -n "$pkg" ] || { echo "Nama paket MainActivity tidak terbaca." >&2; exit 1; }

npm install "@capgo/capacitor-social-login@^7.0.0" --no-audit --no-fund
src=node_modules/@capgo/capacitor-social-login/android/src
[ -d "$src" ] || { echo "Sumber Android plugin tidak ditemukan di $src" >&2; exit 1; }

# Versi plugin tertentu mewajibkan MainActivity mengimplementasikan antarmuka khusus. Kalau antarmukanya tidak ada, tidak perlu menambal.
iface=$(grep -rl "interface ModifiedMainActivityForSocialLoginPlugin" "$src" | head -1 || true)
if [ -z "$iface" ]; then
  echo "Plugin tidak memerlukan perubahan MainActivity."
  exit 0
fi
ppkg=$(grep -m1 '^package ' "$iface" | sed -E 's/^package ([^;]+);.*/\1/')
grep -rq "REQUEST_AUTHORIZE_GOOGLE_MIN" "$src" || { echo "Konstanta REQUEST_AUTHORIZE_GOOGLE_MIN tidak ada; bentuk plugin berubah." >&2; exit 1; }
grep -rq "handleGoogleLoginIntent" "$src" || { echo "Metode handleGoogleLoginIntent tidak ada; bentuk plugin berubah." >&2; exit 1; }

cp "$main" "$main.orig"
cat > "$main" <<JAVA
package $pkg;

import android.content.Intent;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;
import $ppkg.GoogleProvider;
import $ppkg.ModifiedMainActivityForSocialLoginPlugin;
import $ppkg.SocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN && requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
            PluginHandle pluginHandle = getBridge().getPlugin("SocialLogin");
            if (pluginHandle == null) {
                Log.i("SaKu Google", "Plugin SocialLogin tidak ditemukan");
                return;
            }
            Plugin plugin = pluginHandle.getInstance();
            if (!(plugin instanceof SocialLoginPlugin)) {
                Log.i("SaKu Google", "Plugin SocialLogin bukan SocialLoginPlugin");
                return;
            }
            ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
        }
    }

    // Fungsi ini tidak pernah dipanggil; hanya penanda untuk plugin.
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
JAVA
echo "Android: Masuk dengan Google native terpasang (paket plugin $ppkg)."
