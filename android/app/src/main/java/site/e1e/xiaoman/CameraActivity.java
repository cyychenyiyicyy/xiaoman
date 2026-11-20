package site.e1e.xiaoman;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;
import android.view.Display;
import android.view.Surface;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.FileProvider;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.LifecycleRegistry;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 拍题相机：替掉系统相机，用 CameraX 自己画。
 *
 * <p>学习机是前摄俯拍桌面，所以默认前摄、没有前摄退后摄；拍完不直接返回，
 * 先进确认页（重拍 / 使用）。结果落在 {@code getCacheDir()/captures}，
 * 用 FileProvider 发成 content:// 交给 WebView。</p>
 *
 * <p>裸 Activity 不是 LifecycleOwner，这里用 LifecycleRegistry 自己转发，
 * 好让 CameraX 在可见时自动开、不可见时自动关；这样不必为此引入 AppCompat。</p>
 */
public class CameraActivity extends Activity implements LifecycleOwner {

    private static final String TAG = "XiaomanCamera";
    private static final String FILE_PROVIDER_AUTHORITY =
            BuildConfig.APPLICATION_ID + ".fileprovider";

    private static final int REQUEST_CAMERA_PERMISSION = 2001;
    private static final int REQUEST_PICK_IMAGE = 2002;

    private static final String STATE_LENS_FRONT = "lens_front";
    private static final String STATE_FLASH_ON = "flash_on";
    private static final String STATE_RESULT_PATH = "result_path";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Executor mainExecutor = command -> mainHandler.post(command);
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private LifecycleRegistry lifecycleRegistry;

    private PreviewView previewView;
    private View frameView;
    private View topBar;
    private View bottomBar;
    private View confirmView;
    private View panelView;
    private View busyView;
    private ImageView confirmImage;
    private ImageButton flashButton;
    private ImageButton switchButton;
    private TextView lensLabel;
    private TextView panelTitle;
    private TextView panelBody;
    private Button panelSettings;
    private FrameLayout shutter;

    private ProcessCameraProvider cameraProvider;
    private ListenableFuture<ProcessCameraProvider> providerFuture;
    private Camera camera;
    private Preview preview;
    private ImageCapture imageCapture;

    private boolean lensFront = false;
    private boolean flashOn;
    private boolean hasFront;
    private boolean hasBack;
    private boolean hasFlash;
    private boolean started;
    private boolean blocked;
    private boolean confirming;
    private boolean pickingImage;
    private boolean captureInProgress;
    private boolean permissionRequested;
    private boolean keepResult;

    private File resultFile;
    private Uri resultUri;

    @Override
    public Lifecycle getLifecycle() {
        return lifecycleRegistry;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        lifecycleRegistry = new LifecycleRegistry(this);
        lifecycleRegistry.setCurrentState(Lifecycle.State.CREATED);

        setContentView(R.layout.activity_camera);
        bindViews();
        applySystemBars();
        wireListeners();

        if (savedInstanceState != null) {
            lensFront = savedInstanceState.getBoolean(STATE_LENS_FRONT, false);
            flashOn = savedInstanceState.getBoolean(STATE_FLASH_ON, false);
        }
        refreshControls();

        if (savedInstanceState != null) {
            String path = savedInstanceState.getString(STATE_RESULT_PATH);
            if (path != null) {
                File file = new File(path);
                if (file.isFile()) {
                    showConfirm(file);
                }
            }
        }

        io.execute(() -> CameraFiles.purgeStale(this));
    }

    /** Activity 正在销毁时线程池已关，这里统一吞掉拒绝异常，避免收尾阶段崩一次。 */
    private boolean runInBackground(Runnable task) {
        try {
            io.execute(task);
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "Background task rejected", e);
            return false;
        }
    }

    private void bindViews() {
        previewView = findViewById(R.id.camera_preview);
        frameView = findViewById(R.id.camera_frame);
        topBar = findViewById(R.id.camera_top);
        bottomBar = findViewById(R.id.camera_bottom);
        confirmView = findViewById(R.id.camera_confirm);
        panelView = findViewById(R.id.camera_panel);
        busyView = findViewById(R.id.camera_busy);
        confirmImage = findViewById(R.id.camera_confirm_image);
        flashButton = findViewById(R.id.camera_flash);
        switchButton = findViewById(R.id.camera_switch);
        lensLabel = findViewById(R.id.camera_lens);
        panelTitle = findViewById(R.id.camera_panel_title);
        panelBody = findViewById(R.id.camera_panel_body);
        panelSettings = findViewById(R.id.camera_panel_settings);
        shutter = findViewById(R.id.camera_shutter);
    }

    private void wireListeners() {
        findViewById(R.id.camera_close).setOnClickListener(v -> cancelFlow());
        shutter.setOnClickListener(v -> takePicture());
        findViewById(R.id.camera_gallery).setOnClickListener(v -> openGallery());
        flashButton.setOnClickListener(v -> toggleFlash());
        switchButton.setOnClickListener(v -> switchLens());
        findViewById(R.id.camera_retake).setOnClickListener(v -> backToCamera());
        findViewById(R.id.camera_use).setOnClickListener(v -> finishWithResult());
        panelSettings.setOnClickListener(v -> openAppSettings());
        findViewById(R.id.camera_panel_gallery).setOnClickListener(v -> openGallery());
    }

    private void applySystemBars() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        int background = getColor(R.color.camera_bg);
        window.setStatusBarColor(background);
        window.setNavigationBarColor(background);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
        }
        int visibility = window.getDecorView().getSystemUiVisibility();
        visibility &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        visibility &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        window.getDecorView().setSystemUiVisibility(visibility);
    }

    // ---------------------------------------------------------------- 生命周期

    @Override
    protected void onStart() {
        super.onStart();
        started = true;
        lifecycleRegistry.setCurrentState(Lifecycle.State.STARTED);
        if (confirming || blocked || pickingImage) {
            return;
        }
        if (!hasCameraPermission()) {
            requestCameraPermission();
            return;
        }
        startCamera();
    }

    @Override
    protected void onResume() {
        super.onResume();
        lifecycleRegistry.setCurrentState(Lifecycle.State.RESUMED);
        // 从系统设置回来：权限补上了就直接进相机。
        if (blocked && !confirming && hasCameraPermission()) {
            blocked = false;
            showCameraUi();
            startCamera();
        }
    }

    @Override
    protected void onPause() {
        lifecycleRegistry.setCurrentState(Lifecycle.State.STARTED);
        super.onPause();
    }

    @Override
    protected void onStop() {
        started = false;
        lifecycleRegistry.setCurrentState(Lifecycle.State.CREATED);
        stopCamera();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        lifecycleRegistry.setCurrentState(Lifecycle.State.DESTROYED);
        stopCamera();
        cameraProvider = null;
        providerFuture = null;
        mainHandler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        if (isFinishing() && !keepResult) {
            CameraFiles.deleteQuietly(resultFile);
        }
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 不重建：只把 targetRotation 与安全框更新到新方向。
        int rotation = displayRotation();
        if (imageCapture != null) {
            imageCapture.setTargetRotation(rotation);
        }
        if (preview != null) {
            preview.setTargetRotation(rotation);
        }
        if (frameView != null) {
            frameView.invalidate();
        }
    }

    @Override
    public void onBackPressed() {
        cancelFlow();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putBoolean(STATE_LENS_FRONT, lensFront);
        outState.putBoolean(STATE_FLASH_ON, flashOn);
        if (resultFile != null) {
            outState.putString(STATE_RESULT_PATH, resultFile.getAbsolutePath());
        }
    }

    // ------------------------------------------------------------------- 相机

    private boolean hasCameraPermission() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestCameraPermission() {
        if (permissionRequested) {
            showPanel(R.string.camera_permission_title, R.string.camera_permission_body, true);
            return;
        }
        permissionRequested = true;
        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA_PERMISSION);
    }

    private void startCamera() {
        if (confirming || blocked || pickingImage || !hasCameraPermission()) {
            return;
        }
        if (cameraProvider != null) {
            resolveCameras();
            bindUseCases();
            return;
        }
        if (providerFuture != null) {
            return;
        }

        providerFuture = ProcessCameraProvider.getInstance(this);
        providerFuture.addListener(() -> {
            ProcessCameraProvider provider = null;
            try {
                provider = providerFuture.get();
            } catch (Exception e) {
                Log.w(TAG, "Camera provider unavailable", e);
            }
            providerFuture = null;
            if (provider == null) {
                showPanel(R.string.camera_error_title, R.string.camera_error_body, false);
                return;
            }
            if (isFinishing() || isDestroyed()) {
                return;
            }
            cameraProvider = provider;
            if (!started || confirming || blocked) {
                return;
            }
            resolveCameras();
            if (!hasFront && !hasBack) {
                showPanel(R.string.camera_none_title, R.string.camera_none_body, false);
                return;
            }
            bindUseCases();
        }, mainExecutor);
    }

    private void resolveCameras() {
        hasFront = false;
        hasBack = false;
        if (cameraProvider == null) {
            return;
        }
        try {
            hasFront = cameraProvider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA);
            hasBack = cameraProvider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA);
        } catch (Exception e) {
            Log.w(TAG, "Cannot query camera lenses", e);
        }
        if (lensFront && !hasFront) {
            lensFront = false;
        }
        if (!lensFront && !hasBack) {
            lensFront = true;
        }
    }

    private void bindUseCases() {
        if (cameraProvider == null || confirming || blocked || (!hasFront && !hasBack)) {
            return;
        }
        int rotation = displayRotation();

        Preview previewUseCase = new Preview.Builder()
                .setTargetRotation(rotation)
                .build();
        previewUseCase.setSurfaceProvider(previewView.getSurfaceProvider());

        ImageCapture captureUseCase = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .setTargetRotation(rotation)
                .build();

        CameraSelector selector = lensFront
                ? CameraSelector.DEFAULT_FRONT_CAMERA
                : CameraSelector.DEFAULT_BACK_CAMERA;

        cameraProvider.unbindAll();
        try {
            camera = cameraProvider.bindToLifecycle(this, selector, previewUseCase, captureUseCase);
        } catch (RuntimeException e) {
            Log.w(TAG, "bindToLifecycle failed", e);
            camera = null;
            preview = null;
            imageCapture = null;
            showPanel(R.string.camera_error_title, R.string.camera_error_body, false);
            return;
        }

        preview = previewUseCase;
        imageCapture = captureUseCase;

        boolean flashUnit = false;
        try {
            flashUnit = camera.getCameraInfo().hasFlashUnit();
        } catch (RuntimeException e) {
            Log.w(TAG, "Cannot read flash availability", e);
        }
        hasFlash = flashUnit && !lensFront;
        if (lensFront) {
            flashOn = false;
        }
        applyFlashMode();
        refreshControls();
    }

    private void stopCamera() {
        preview = null;
        imageCapture = null;
        camera = null;
        if (cameraProvider != null) {
            try {
                cameraProvider.unbindAll();
            } catch (RuntimeException e) {
                Log.w(TAG, "unbindAll failed", e);
            }
        }
    }

    private int displayRotation() {
        Display display;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display = getDisplay();
        } else {
            display = getWindowManager().getDefaultDisplay();
        }
        return display == null ? Surface.ROTATION_0 : display.getRotation();
    }

    private void applyFlashMode() {
        if (imageCapture == null) {
            return;
        }
        int mode = (!lensFront && hasFlash && flashOn)
                ? ImageCapture.FLASH_MODE_ON
                : ImageCapture.FLASH_MODE_OFF;
        try {
            imageCapture.setFlashMode(mode);
        } catch (RuntimeException e) {
            Log.w(TAG, "setFlashMode failed", e);
        }
    }

    private void toggleFlash() {
        if (lensFront || !hasFlash) {
            return;
        }
        flashOn = !flashOn;
        applyFlashMode();
        refreshControls();
    }

    private void switchLens() {
        if (!hasFront || !hasBack) {
            return;
        }
        lensFront = !lensFront;
        flashOn = false;
        hasFlash = false;
        refreshControls();
        bindUseCases();
    }

    private void refreshControls() {
        if (lensLabel != null) {
            lensLabel.setText(lensFront ? R.string.camera_lens_front : R.string.camera_lens_back);
        }
        if (flashButton != null) {
            boolean flashUsable = !lensFront && hasFlash;
            flashButton.setVisibility(flashUsable ? View.VISIBLE : View.INVISIBLE);
            flashButton.setImageResource(flashOn
                    ? R.drawable.ic_camera_flash_on
                    : R.drawable.ic_camera_flash);
            flashButton.setContentDescription(getString(flashOn
                    ? R.string.camera_flash_off
                    : R.string.camera_flash_on));
        }
        if (switchButton != null) {
            switchButton.setVisibility(hasFront && hasBack ? View.VISIBLE : View.INVISIBLE);
        }
    }

    // ------------------------------------------------------------------- 拍照

    private void takePicture() {
        if (confirming || captureInProgress || imageCapture == null) {
            return;
        }
        File file = CameraFiles.newFile(this, "xiaoman", ".jpg");
        if (file == null) {
            toast(R.string.camera_save_failed);
            return;
        }

        captureInProgress = true;
        setBusy(true);
        ImageCapture.OutputFileOptions options =
                new ImageCapture.OutputFileOptions.Builder(file).build();
        imageCapture.takePicture(options, io, new ImageCapture.OnImageSavedCallback() {
            @Override
            public void onImageSaved(ImageCapture.OutputFileResults outputFileResults) {
                CameraFiles.normalizeJpeg(file);
                mainExecutor.execute(() -> {
                    captureInProgress = false;
                    if (isFinishing() || isDestroyed()) {
                        setBusy(false);
                        CameraFiles.deleteQuietly(file);
                        return;
                    }
                    setBusy(false);
                    showConfirm(file);
                });
            }

            @Override
            public void onError(ImageCaptureException exception) {
                Log.w(TAG, "takePicture failed", exception);
                CameraFiles.deleteQuietly(file);
                mainExecutor.execute(() -> {
                    captureInProgress = false;
                    setBusy(false);
                    if (!isFinishing() && !isDestroyed()) {
                        toast(R.string.camera_capture_failed);
                    }
                });
            }
        });
    }

    // ----------------------------------------------------------------- 相册

    private void openGallery() {
        if (pickingImage) {
            return;
        }
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
            intent.setType("image/*");
        } else {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("image/*");
        }
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            pickingImage = true;
            startActivityForResult(intent, REQUEST_PICK_IMAGE);
        } catch (ActivityNotFoundException | SecurityException e) {
            pickingImage = false;
            Log.w(TAG, "No gallery app available", e);
            toast(R.string.no_file_picker);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_PICK_IMAGE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        pickingImage = false;
        Uri picked = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        if (picked == null) {
            // 取消选图：回到相机（onStart 时因为 pickingImage 跳过了绑定）。
            if (!confirming && !blocked) {
                startCamera();
            }
            return;
        }
        importPickedImage(picked);
    }

    /**
     * 相册图先复制进自己的 cache 再进确认页：既统一了返回的 content://，
     * 也不再依赖别的 App 的临时读授权。
     */
    private void importPickedImage(Uri source) {
        setBusy(true);
        io.execute(() -> {
            File temp = CameraFiles.newFile(this, "pick", ".tmp");
            boolean copied = temp != null && CameraFiles.copyUriToFile(getContentResolver(), source, temp);
            File target = null;
            if (copied) {
                String suffix = CameraFiles.sniffSuffix(temp);
                target = CameraFiles.newFile(this, "pick", suffix);
                if (target != null && !temp.renameTo(target)) {
                    CameraFiles.deleteQuietly(target);
                    target = null;
                }
                if (target != null && ".jpg".equals(suffix)) {
                    CameraFiles.normalizeJpeg(target);
                }
            }
            CameraFiles.deleteQuietly(temp);

            final File ready = copied ? target : null;
            mainExecutor.execute(() -> {
                setBusy(false);
                if (isFinishing() || isDestroyed()) {
                    CameraFiles.deleteQuietly(ready);
                    return;
                }
                if (ready == null) {
                    toast(R.string.camera_save_failed);
                    if (!confirming && !blocked) {
                        startCamera();
                    }
                    return;
                }
                showConfirm(ready);
            });
        });
    }

    // --------------------------------------------------------------- 确认页

    private void showConfirm(File file) {
        if (file == null || !file.isFile()) {
            toast(R.string.camera_save_failed);
            return;
        }
        Uri uri;
        try {
            uri = FileProvider.getUriForFile(this, FILE_PROVIDER_AUTHORITY, file);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "Cannot expose capture", e);
            CameraFiles.deleteQuietly(file);
            toast(R.string.camera_save_failed);
            return;
        }

        // 换一张就先清掉上一张，免得 cache 里堆。
        if (resultFile != null && !resultFile.equals(file)) {
            CameraFiles.deleteQuietly(resultFile);
        }

        resultFile = file;
        resultUri = uri;
        confirming = true;
        blocked = false;
        stopCamera();

        previewView.setVisibility(View.INVISIBLE);
        frameView.setVisibility(View.INVISIBLE);
        bottomBar.setVisibility(View.GONE);
        flashButton.setVisibility(View.GONE);
        switchButton.setVisibility(View.GONE);
        panelView.setVisibility(View.GONE);
        confirmView.setVisibility(View.VISIBLE);
        topBar.setVisibility(View.VISIBLE);

        loadConfirmPreview(file);
    }

    private void loadConfirmPreview(final File file) {
        setBusy(true);
        boolean scheduled = runInBackground(() -> {
            final Bitmap bitmap = CameraFiles.loadPreview(file, 1440);
            mainExecutor.execute(() -> {
                setBusy(false);
                if (isFinishing() || isDestroyed() || confirmImage == null) {
                    if (bitmap != null) {
                        bitmap.recycle();
                    }
                    return;
                }
                confirmImage.setImageBitmap(bitmap);
            });
        });
        if (!scheduled) {
            setBusy(false);
        }
    }

    private void backToCamera() {
        CameraFiles.deleteQuietly(resultFile);
        resultFile = null;
        resultUri = null;
        confirming = false;
        confirmImage.setImageDrawable(null);
        confirmView.setVisibility(View.GONE);
        showCameraUi();
        if (hasCameraPermission()) {
            startCamera();
        } else {
            requestCameraPermission();
        }
    }

    private void finishWithResult() {
        if (resultUri == null) {
            cancelFlow();
            return;
        }
        keepResult = true;
        Intent data = new Intent();
        data.setData(resultUri);
        data.setClipData(ClipData.newRawUri(null, resultUri));
        data.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        setResult(RESULT_OK, data);
        finish();
    }

    private void cancelFlow() {
        keepResult = false;
        setResult(RESULT_CANCELED);
        finish();
    }

    // ---------------------------------------------------------------- 面板/状态

    private void showCameraUi() {
        confirming = false;
        blocked = false;
        confirmView.setVisibility(View.GONE);
        panelView.setVisibility(View.GONE);
        previewView.setVisibility(View.VISIBLE);
        frameView.setVisibility(View.VISIBLE);
        bottomBar.setVisibility(View.VISIBLE);
        topBar.setVisibility(View.VISIBLE);
        refreshControls();
    }

    private void showPanel(int titleRes, int bodyRes, boolean withSettings) {
        blocked = true;
        confirming = false;
        stopCamera();
        previewView.setVisibility(View.INVISIBLE);
        frameView.setVisibility(View.INVISIBLE);
        bottomBar.setVisibility(View.GONE);
        confirmView.setVisibility(View.GONE);
        flashButton.setVisibility(View.GONE);
        switchButton.setVisibility(View.GONE);
        panelTitle.setText(titleRes);
        panelBody.setText(bodyRes);
        panelSettings.setVisibility(withSettings ? View.VISIBLE : View.GONE);
        panelView.setVisibility(View.VISIBLE);
        topBar.setVisibility(View.VISIBLE);
    }

    private void setBusy(boolean busy) {
        busyView.setVisibility(busy ? View.VISIBLE : View.GONE);
        shutter.setEnabled(!busy);
        shutter.setAlpha(busy ? 0.6f : 1f);
    }

    private void openAppSettings() {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getPackageName(), null));
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            toast(R.string.camera_error_body);
        }
    }

    // ------------------------------------------------------------------ 权限

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        if (requestCode != REQUEST_CAMERA_PERMISSION) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            blocked = false;
            panelView.setVisibility(View.GONE);
            showCameraUi();
            startCamera();
        } else {
            showPanel(R.string.camera_permission_title, R.string.camera_permission_body, true);
        }
    }

    private void toast(int messageRes) {
        Toast.makeText(this, messageRes, Toast.LENGTH_SHORT).show();
    }
}
