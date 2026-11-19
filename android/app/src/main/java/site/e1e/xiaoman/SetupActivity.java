package site.e1e.xiaoman;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 第一启动 / 更换服务器：只填地址，连接成功后保存，之后 MainActivity 自动加载。
 * 不在 APK 里写死任何 IP；地址存在 SharedPreferences（不参与云同步）。
 */
public class SetupActivity extends Activity {

    public static final String PREFS = "xiaoman_shell";
    public static final String KEY_URL = "server_url";
    private static final String UA = "XiaomanAlpha/0.2";

    private EditText urlInput;
    private TextView errorView;
    private Button connectButton;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String saved = prefs.getString(KEY_URL, "");
        if (!TextUtils.isEmpty(saved)) {
            startMain();
            return;
        }

        setContentView(R.layout.activity_setup);
        urlInput = findViewById(R.id.setup_url);
        errorView = findViewById(R.id.setup_error);
        connectButton = findViewById(R.id.setup_connect);

        connectButton.setOnClickListener(v -> connect());
        urlInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) {
                connect();
                return true;
            }
            return false;
        });
    }

    private void connect() {
        String base = normalize(urlInput.getText().toString());
        if (base == null) {
            showError(getString(R.string.setup_error_format));
            return;
        }
        errorView.setVisibility(View.GONE);
        connectButton.setEnabled(false);
        connectButton.setText(R.string.setup_connecting);
        final String target = base;

        executor.execute(() -> {
            boolean ok = probe(target);
            main.post(() -> {
                connectButton.setEnabled(true);
                connectButton.setText(R.string.setup_connect);
                if (!ok) {
                    showError(getString(R.string.setup_error_connect));
                    return;
                }
                getSharedPreferences(PREFS, MODE_PRIVATE)
                        .edit().putString(KEY_URL, target).apply();
                startMain();
            });
        });
    }

    private void startMain() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    private void showError(String text) {
        errorView.setText(text);
        errorView.setVisibility(View.VISIBLE);
    }

    /** 只接受 http(s)://host[:port]，路径/查询串丢掉；纯 IP 自动补 http://。 */
    private static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return null;
        if (!s.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*")) s = "http://" + s;
        Uri u = Uri.parse(s);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        String host = u.getHost();
        if (host == null || host.isEmpty()) return null;
        int port = u.getPort();
        return scheme + "://" + host + (port > 0 ? ":" + port : "");
    }

    private static boolean probe(String base) {
        return probeUrl(base + "/health") || probeUrl(base + "/");
    }

    private static boolean probeUrl(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(7000);
            conn.setReadTimeout(7000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", UA);
            int code = conn.getResponseCode();
            return code >= 200 && code < 500; // 404 也说明服务在，交给 WebView 显示
        } catch (IOException e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }
}
