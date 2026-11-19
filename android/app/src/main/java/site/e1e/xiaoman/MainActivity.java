package site.e1e.xiaoman;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 小满 Android 壳：一个 Activity + 系统 WebView。
 *
 * <p>正式版是自建服务器上的响应式 Web 应用；这里只负责承载它，
 * 并补上 WebView 本身做不到的几件事：文件/相机选择、系统栏颜色、
 * 外部链接与下载、离线兜底。刻意不引入 AppCompat / Material / Compose。</p>
 */
public class MainActivity extends Activity {

    private static final String TAG = "XiaomanShell";
    private String serverUrl = "";
    private Uri serverUri;
    private static final String FILE_PROVIDER_AUTHORITY =
            BuildConfig.APPLICATION_ID + ".fileprovider";
    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_WEB_PERMISSIONS = 1002;

    private WebView webView;
    private ProgressBar progressBar;
    private View offlineView;
    private TextView offlineHost;

    private boolean mainFrameError;
    private boolean hasLoadedOnce;

    private ValueCallback<Uri[]> filePathCallback;
    private Uri cameraOutputUri;
    private File cameraOutputFile;
    private PermissionRequest pendingPermissionRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress);
        offlineView = findViewById(R.id.offline);
        offlineHost = findViewById(R.id.offline_host);

        Button retry = findViewById(R.id.btn_retry);
        retry.setOnClickListener(v -> reload());
        Button openBrowser = findViewById(R.id.btn_browser);
        openBrowser.setOnClickListener(v -> openExternally(serverUri));
        Button changeServer = findViewById(R.id.btn_change_server);
        changeServer.setOnClickListener(v -> changeServer());

        serverUrl = getSharedPreferences(SetupActivity.PREFS, MODE_PRIVATE)
                .getString(SetupActivity.KEY_URL, "");
        if (serverUrl == null || serverUrl.isEmpty()) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }
        serverUri = Uri.parse(serverUrl);

        // 首次空白/离线页长按可重新加载；页面正常后长按仍归 WebView（选词）。
        offlineView.setOnLongClickListener(v -> {
            reload();
            return true;
        });

        applySystemBars();
        configureWebView();

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            loadServer();
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Caddy 用这个前缀把请求分流到 xiaoman；保留完整 Chrome UA，M3 Web 不受影响。
        settings.setUserAgentString("XiaomanAlpha/0.2 " + settings.getUserAgentString());

        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) {
            WebSettingsCompat.setSafeBrowsingEnabled(settings, true);
        }

        webView.setBackgroundColor(getColor(R.color.surface));
        webView.setWebViewClient(new XiaomanWebViewClient());
        webView.setWebChromeClient(new XiaomanChromeClient());
        webView.setDownloadListener(this::handleDownload);
        webView.setOnLongClickListener(v -> {
            if (!hasLoadedOnce || offlineView.getVisibility() == View.VISIBLE) {
                reload();
                return true;
            }
            return false;
        });

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    private void loadServer() {
        mainFrameError = false;
        offlineView.setVisibility(View.GONE);
        progressBar.setProgress(0);
        progressBar.setVisibility(View.VISIBLE);
        webView.loadUrl(serverUrl);
    }

    private void changeServer() {
        getSharedPreferences(SetupActivity.PREFS, MODE_PRIVATE)
                .edit().remove(SetupActivity.KEY_URL).apply();
        Intent intent = new Intent(this, SetupActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
        finish();
    }

    private void reload() {
        if (webView == null) {
            return;
        }
        mainFrameError = false;
        offlineView.setVisibility(View.GONE);
        progressBar.setProgress(0);
        progressBar.setVisibility(View.VISIBLE);

        String current = webView.getUrl();
        if (current == null || current.isEmpty() || "about:blank".equals(current)) {
            webView.loadUrl(serverUrl);
        } else {
            webView.reload();
        }
    }

    private void showOffline(String reason) {
        Log.w(TAG, "Main frame failed: " + reason);
        mainFrameError = true;
        progressBar.setVisibility(View.GONE);
        offlineHost.setText(serverUrl);
        offlineView.setVisibility(View.VISIBLE);
        offlineView.bringToFront();
    }

    private boolean handleUri(Uri uri) {
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme();
        if (scheme == null) {
            return false;
        }
        scheme = scheme.toLowerCase(Locale.ROOT);

        if ("http".equals(scheme) || "https".equals(scheme)) {
            if (isInternal(uri)) {
                return false;
            }
            return openExternally(uri);
        }
        if ("about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme)
                || "javascript".equals(scheme)) {
            return false;
        }
        if ("file".equals(scheme) || "content".equals(scheme)) {
            return true;
        }
        return openExternally(uri);
    }

    private boolean isInternal(Uri uri) {
        String host = uri.getHost();
        String serverHost = serverUri == null ? null : serverUri.getHost();
        if (host == null || serverHost == null) {
            return false;
        }
        if (!host.equalsIgnoreCase(serverHost)) {
            return false;
        }
        return effectivePort(uri) == effectivePort(serverUri);
    }

    private static int effectivePort(Uri uri) {
        int port = uri.getPort();
        if (port != -1) {
            return port;
        }
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private boolean openExternally(Uri uri) {
        if (uri == null) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
            return true;
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
            return true;
        }
    }

    private void handleDownload(String url, String userAgent, String contentDisposition,
                                String mimeType, long contentLength) {
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
            return;
        }

        // API 29+ 的 DownloadManager 写公共 Downloads 不需要存储权限。
        // 更老的系统交给浏览器，避免为一次下载申请 WRITE_EXTERNAL_STORAGE。
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            openExternally(Uri.parse(url));
            return;
        }

        try {
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            fileName = fileName.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
            if (fileName.isEmpty() || ".".equals(fileName) || "..".equals(fileName)) {
                fileName = "xiaoman-download";
            }

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            if (mimeType != null && !mimeType.isEmpty()) {
                request.setMimeType(mimeType);
            }
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) {
                request.addRequestHeader("Cookie", cookie);
            }
            if (userAgent != null && !userAgent.isEmpty()) {
                request.addRequestHeader("User-Agent", userAgent);
            }
            request.setTitle(fileName);
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) {
                throw new IllegalStateException("DownloadManager is unavailable");
            }
            manager.enqueue(request);
            Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show();
        } catch (RuntimeException e) {
            Log.w(TAG, "DownloadManager failed; falling back to the browser", e);
            openExternally(Uri.parse(url));
        }
    }

    private void applySystemBars() {
        boolean night = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int barColor = getColor(night ? R.color.surface_dark : R.color.clay_bar);

        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        window.setStatusBarColor(barColor);
        window.setNavigationBarColor(barColor);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
        }

        int visibility = window.getDecorView().getSystemUiVisibility();
        if (Color.luminance(barColor) > 0.5f) {
            visibility |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            visibility |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        } else {
            visibility &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            visibility &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        window.getDecorView().setSystemUiVisibility(visibility);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) {
            webView.saveState(outState);
        }
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBars();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }

        Uri[] results = null;
        if (resultCode == RESULT_OK) {
            if (data != null) {
                ClipData clipData = data.getClipData();
                if (clipData != null && clipData.getItemCount() > 0) {
                    List<Uri> uris = new ArrayList<>();
                    for (int i = 0; i < clipData.getItemCount(); i++) {
                        Uri uri = clipData.getItemAt(i).getUri();
                        if (uri != null) {
                            uris.add(uri);
                        }
                    }
                    if (!uris.isEmpty()) {
                        results = uris.toArray(new Uri[0]);
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            if (results == null && cameraOutputUri != null) {
                results = new Uri[]{cameraOutputUri};
            }
        }

        boolean usedCamera = false;
        if (results != null && cameraOutputUri != null) {
            for (Uri uri : results) {
                if (cameraOutputUri.equals(uri)) {
                    usedCamera = true;
                    break;
                }
            }
        }

        ValueCallback<Uri[]> callback = filePathCallback;
        filePathCallback = null;
        if (callback != null) {
            callback.onReceiveValue(results);
        }

        if (usedCamera) {
            cameraOutputUri = null;
            cameraOutputFile = null;
        } else {
            cleanupCameraFile();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        if (requestCode != REQUEST_WEB_PERMISSIONS) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);
            return;
        }

        PermissionRequest pending = pendingPermissionRequest;
        pendingPermissionRequest = null;
        if (pending == null) {
            return;
        }

        boolean granted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) {
                granted = false;
                break;
            }
        }
        if (granted) {
            grantPermission(pending);
        } else {
            denyPermission(pending);
        }
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (pendingPermissionRequest != null) {
            denyPermission(pendingPermissionRequest);
            pendingPermissionRequest = null;
        }
        cleanupCameraFile();

        if (webView != null) {
            if (webView.getParent() instanceof ViewGroup) {
                ((ViewGroup) webView.getParent()).removeView(webView);
            }
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.loadUrl("about:blank");
            webView.clearHistory();
            webView.removeAllViews();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private Intent createCameraIntent() {
        PackageManager packageManager = getPackageManager();
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            return null;
        }
        Uri output = createCameraOutputUri();
        if (output == null) {
            return null;
        }

        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        intent.putExtra(MediaStore.EXTRA_OUTPUT, output);
        // 学习机前摄是俯拍机位；这是 OEM 相机常见的非官方前摄提示。
        intent.putExtra("android.intent.extras.CAMERA_FACING", 1);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_READ_URI_PERMISSION);

        if (intent.resolveActivity(packageManager) == null) {
            cleanupCameraFile();
            return null;
        }
        cameraOutputUri = output;
        return intent;
    }

    private Uri createCameraOutputUri() {
        File base = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        if (base == null) {
            base = getCacheDir();
        }
        File directory = new File(base, "captures");
        if (!directory.exists() && !directory.mkdirs()) {
            Log.w(TAG, "Cannot create camera output directory");
            return null;
        }

        File file = new File(directory, "xiaoman_" + System.currentTimeMillis() + ".jpg");
        try {
            if (!file.createNewFile()) {
                Log.w(TAG, "Cannot create camera output file");
                return null;
            }
            Uri uri = FileProvider.getUriForFile(this, FILE_PROVIDER_AUTHORITY, file);
            cameraOutputFile = file;
            return uri;
        } catch (IOException | IllegalArgumentException e) {
            Log.w(TAG, "Cannot prepare camera output", e);
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return null;
        }
    }

    private void cleanupCameraFile() {
        if (cameraOutputFile != null) {
            //noinspection ResultOfMethodCallIgnored
            cameraOutputFile.delete();
        }
        cameraOutputFile = null;
        cameraOutputUri = null;
    }

    private boolean acceptsImages(WebChromeClient.FileChooserParams params) {
        String[] types = params.getAcceptTypes();
        if (types == null || types.length == 0) {
            return true;
        }
        for (String type : types) {
            if (type == null) {
                continue;
            }
            String value = type.trim().toLowerCase(Locale.ROOT);
            if (value.isEmpty() || "*/*".equals(value) || value.contains("image")) {
                return true;
            }
            if (value.endsWith(".jpg") || value.endsWith(".jpeg") || value.endsWith(".png")
                    || value.endsWith(".webp") || value.endsWith(".heic")) {
                return true;
            }
        }
        return false;
    }

    private void grantPermission(PermissionRequest request) {
        try {
            request.grant(request.getResources());
        } catch (RuntimeException e) {
            Log.w(TAG, "Web permission request is no longer valid", e);
        }
    }

    private void denyPermission(PermissionRequest request) {
        try {
            request.deny();
        } catch (RuntimeException e) {
            Log.w(TAG, "Web permission request is no longer valid", e);
        }
    }

    private class XiaomanWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUri(request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            mainFrameError = false;
            offlineView.setVisibility(View.GONE);
            progressBar.setProgress(0);
            progressBar.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progressBar.setVisibility(View.GONE);
            if (!mainFrameError) {
                offlineView.setVisibility(View.GONE);
                hasLoadedOnce = true;
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                                    WebResourceError error) {
            if (request.isForMainFrame()) {
                CharSequence description = error.getDescription();
                showOffline(description == null ? "" : description.toString());
            }
        }
    }

    private class XiaomanChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            if (mainFrameError) {
                progressBar.setVisibility(View.GONE);
                return;
            }
            progressBar.setProgress(newProgress);
            progressBar.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         WebChromeClient.FileChooserParams params) {
            if (callback == null) {
                return false;
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            cleanupCameraFile();
            filePathCallback = callback;

            if (params == null) {
                filePathCallback = null;
                callback.onReceiveValue(null);
                return true;
            }

            Intent contentIntent = params.createIntent();
            if (contentIntent == null) {
                contentIntent = new Intent(Intent.ACTION_GET_CONTENT);
                contentIntent.addCategory(Intent.CATEGORY_OPENABLE);
                contentIntent.setType("*/*");
            }

            Intent chooser = Intent.createChooser(contentIntent,
                    getString(R.string.file_chooser_title));
            if (acceptsImages(params)) {
                Intent captureIntent = createCameraIntent();
                if (captureIntent != null) {
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS,
                            new Intent[]{captureIntent});
                }
            }

            try {
                startActivityForResult(chooser, REQUEST_FILE_CHOOSER);
                return true;
            } catch (ActivityNotFoundException e) {
                filePathCallback = null;
                cleanupCameraFile();
                callback.onReceiveValue(null);
                Toast.makeText(MainActivity.this, R.string.no_file_picker,
                        Toast.LENGTH_SHORT).show();
                return false;
            }
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(() -> {
                boolean wantsCamera = false;
                boolean wantsAudio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                        wantsCamera = true;
                    } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        wantsAudio = true;
                    } else {
                        denyPermission(request);
                        return;
                    }
                }
                if (!wantsCamera && !wantsAudio) {
                    denyPermission(request);
                    return;
                }

                List<String> missing = new ArrayList<>();
                if (wantsCamera && checkSelfPermission(Manifest.permission.CAMERA)
                        != PackageManager.PERMISSION_GRANTED) {
                    missing.add(Manifest.permission.CAMERA);
                }
                if (wantsAudio && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED) {
                    missing.add(Manifest.permission.RECORD_AUDIO);
                }
                if (missing.isEmpty()) {
                    grantPermission(request);
                    return;
                }

                if (pendingPermissionRequest != null) {
                    denyPermission(pendingPermissionRequest);
                }
                pendingPermissionRequest = request;
                requestPermissions(missing.toArray(new String[0]), REQUEST_WEB_PERMISSIONS);
            });
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message,
                                 final JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(R.string.app_name)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok,
                            (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message,
                                   final JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(R.string.app_name)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok,
                            (dialog, which) -> result.confirm())
                    .setNegativeButton(android.R.string.cancel,
                            (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message,
                                  String defaultValue, final JsPromptResult result) {
            final EditText input = new EditText(MainActivity.this);
            input.setText(defaultValue == null ? "" : defaultValue);
            input.setSingleLine(false);
            input.setMinLines(1);
            input.setMaxLines(4);

            FrameLayout container = new FrameLayout(MainActivity.this);
            container.setPadding(dp(20), dp(8), dp(20), 0);
            container.addView(input, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT));

            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(R.string.app_name)
                    .setMessage(message)
                    .setView(container)
                    .setPositiveButton(android.R.string.ok,
                            (dialog, which) -> result.confirm(input.getText().toString()))
                    .setNegativeButton(android.R.string.cancel,
                            (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
            return true;
        }
    }
}
