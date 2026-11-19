package site.e1e.xiaoman;

import android.content.ContentResolver;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.util.Log;

import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 拍题产物的文件层：方向校正、预览解码、从相册复制、顺手清理。
 *
 * <p>相机和相册的图都落到 {@link Context#getCacheDir()} 下，再用 FileProvider 暴露成
 * content://，这样 WebView 一定读得到，也不依赖别的 App 的临时授权。</p>
 */
final class CameraFiles {

    private static final String TAG = "XiaomanCamera";
    private static final String DIRECTORY = "captures";
    /** 超过这个长边就先降采样，避免旋转时 OOM。 */
    private static final int MAX_EDGE = 3840;
    private static final int JPEG_QUALITY = 92;
    private static final long KEEP_MILLIS = 24L * 60L * 60L * 1000L;

    private CameraFiles() {
    }

    static File capturesDir(Context context) {
        File dir = new File(context.getCacheDir(), DIRECTORY);
        if (dir.isDirectory()) {
            return dir;
        }
        if (dir.mkdirs() || dir.isDirectory()) {
            return dir;
        }
        Log.w(TAG, "Cannot create capture directory");
        return null;
    }

    static File newFile(Context context, String prefix, String suffix) {
        File dir = capturesDir(context);
        if (dir == null) {
            return null;
        }
        return new File(dir, prefix + "_" + System.currentTimeMillis() + suffix);
    }

    /** 把 EXIF 方向真正转进像素，再重新编码；失败就保持原样（EXIF 还在，浏览器照样看正）。 */
    static void normalizeJpeg(File file) {
        if (file == null || !file.isFile() || !isJpeg(file)) {
            return;
        }
        int orientation = readOrientation(file);
        if (orientation == ExifInterface.ORIENTATION_NORMAL
                || orientation == ExifInterface.ORIENTATION_UNDEFINED) {
            return;
        }

        Bitmap bitmap = null;
        try {
            bitmap = decodeOriented(file, orientation, MAX_EDGE);
            if (bitmap == null) {
                Log.w(TAG, "Skip orientation fix; EXIF kept");
                return;
            }
            if (!writeJpeg(file, bitmap)) {
                Log.w(TAG, "Cannot rewrite rotated jpeg");
            }
        } catch (OutOfMemoryError e) {
            Log.w(TAG, "Skip orientation fix: out of memory");
        } finally {
            if (bitmap != null) {
                bitmap.recycle();
            }
        }
    }

    static Bitmap loadPreview(File file, int maxEdge) {
        if (file == null || !file.isFile()) {
            return null;
        }
        try {
            return decodeOriented(file, readOrientation(file), maxEdge);
        } catch (OutOfMemoryError e) {
            Log.w(TAG, "Preview decode out of memory", e);
            return null;
        }
    }

    static boolean copyUriToFile(ContentResolver resolver, Uri source, File target) {
        if (resolver == null || source == null || target == null) {
            return false;
        }
        InputStream in = null;
        FileOutputStream out = null;
        try {
            in = resolver.openInputStream(source);
            if (in == null) {
                return false;
            }
            out = new FileOutputStream(target);
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
            return true;
        } catch (IOException | SecurityException e) {
            Log.w(TAG, "Cannot copy picked image", e);
            return false;
        } finally {
            closeQuietly(in);
            closeQuietly(out);
        }
    }

    /** 按文件头猜后缀，避免把 png 当 jpg 交给 Web 端。 */
    static String sniffSuffix(File file) {
        if (file == null || !file.isFile()) {
            return ".jpg";
        }
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] head = new byte[12];
            int read = in.read(head);
            if (read >= 2 && (head[0] & 0xFF) == 0xFF && (head[1] & 0xFF) == 0xD8) {
                return ".jpg";
            }
            if (read >= 4 && (head[0] & 0xFF) == 0x89 && head[1] == 'P'
                    && head[2] == 'N' && head[3] == 'G') {
                return ".png";
            }
            if (read >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F'
                    && head[8] == 'W' && head[9] == 'E' && head[10] == 'B' && head[11] == 'P') {
                return ".webp";
            }
        } catch (IOException e) {
            Log.w(TAG, "Cannot sniff image header", e);
        }
        return ".jpg";
    }

    /** 清掉一天前的临时图；当前这张刚生成，不会被扫到。 */
    static void purgeStale(Context context) {
        File dir = capturesDir(context);
        if (dir == null) {
            return;
        }
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - KEEP_MILLIS;
        for (File file : files) {
            if (file != null && file.isFile() && file.lastModified() < cutoff) {
                deleteQuietly(file);
            }
        }
    }

    static void deleteQuietly(File file) {
        if (file == null) {
            return;
        }
        try {
            if (file.isFile() && !file.delete()) {
                Log.w(TAG, "Cannot delete " + file.getName());
            }
        } catch (SecurityException e) {
            Log.w(TAG, "Cannot delete temp file", e);
        }
    }

    private static boolean isJpeg(File file) {
        try (FileInputStream in = new FileInputStream(file)) {
            int first = in.read();
            int second = in.read();
            return first == 0xFF && second == 0xD8;
        } catch (IOException e) {
            return false;
        }
    }

    private static int readOrientation(File file) {
        try {
            ExifInterface exif = new ExifInterface(file.getAbsolutePath());
            return exif.getAttributeInt(ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL);
        } catch (IOException | RuntimeException e) {
            return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    /** 解码并按 EXIF 方向摆正；任一环节失败都返回 null，让调用方保持原文件。 */
    private static Bitmap decodeOriented(File file, int orientation, int maxEdge) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        int longEdge = Math.max(bounds.outWidth, bounds.outHeight);
        if (longEdge <= 0) {
            return null;
        }

        int sample = 1;
        while (longEdge / sample > maxEdge && sample < 16) {
            sample *= 2;
        }

        for (int attempt = 0; attempt < 3; attempt++) {
            Bitmap source = decodeSampled(file, sample);
            if (source != null) {
                Bitmap oriented = applyOrientation(source, orientation);
                if (oriented == null) {
                    source.recycle();
                    return null;
                }
                if (oriented != source) {
                    source.recycle();
                }
                return oriented;
            }
            sample *= 2;
        }
        return null;
    }

    private static Bitmap decodeSampled(File file, int sample) {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = Math.max(1, sample);
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        try {
            return BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        } catch (OutOfMemoryError e) {
            Log.w(TAG, "Decode out of memory at sample " + sample);
            return null;
        }
    }

    private static Bitmap applyOrientation(Bitmap source, int orientation) {
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                matrix.setScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                matrix.setRotate(180f);
                break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                matrix.setScale(1f, -1f);
                break;
            case ExifInterface.ORIENTATION_TRANSPOSE:
                matrix.setRotate(90f);
                matrix.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_90:
                matrix.setRotate(90f);
                break;
            case ExifInterface.ORIENTATION_TRANSVERSE:
                matrix.setRotate(270f);
                matrix.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                matrix.setRotate(270f);
                break;
            default:
                return source;
        }
        try {
            return Bitmap.createBitmap(source, 0, 0, source.getWidth(), source.getHeight(),
                    matrix, true);
        } catch (OutOfMemoryError | IllegalArgumentException e) {
            Log.w(TAG, "Cannot rotate bitmap", e);
            return null;
        }
    }

    /** 先写 .tmp 再改名，避免确认页读到写了一半的图。 */
    private static boolean writeJpeg(File target, Bitmap bitmap) {
        File temp = new File(target.getParentFile(), target.getName() + ".tmp");
        boolean written = false;
        try (FileOutputStream out = new FileOutputStream(temp)) {
            written = bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
            out.flush();
        } catch (IOException e) {
            Log.w(TAG, "Cannot write rotated jpeg", e);
            deleteQuietly(temp);
            return false;
        }
        if (!written) {
            deleteQuietly(temp);
            return false;
        }
        if (temp.renameTo(target)) {
            return true;
        }
        // 同一目录下 rename 基本不会失败；真失败就放弃，别把原图弄丢。
        Log.w(TAG, "Cannot replace jpeg in place");
        deleteQuietly(temp);
        return false;
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (IOException ignored) {
            // 关掉就行
        }
    }
}
