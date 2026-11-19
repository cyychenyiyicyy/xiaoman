package site.e1e.xiaoman;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

/**
 * 取景安全框：细白线圆角矩形，竖屏 3:4、横屏 4:3，只画线不压暗预览。
 * 边距直接用 View 的 padding 来定，布局里调 paddingBottom 就能让开底部操作条。
 */
public class CaptureFrameView extends View {

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF frame = new RectF();
    private final float density;

    public CaptureFrameView(Context context) {
        this(context, null);
    }

    public CaptureFrameView(Context context, AttributeSet attrs) {
        super(context, attrs);
        density = getResources().getDisplayMetrics().density;
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1.25f * density);
        paint.setColor(context.getColor(R.color.camera_frame_line));
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);

        float left = getPaddingLeft();
        float top = getPaddingTop();
        float right = getWidth() - getPaddingRight();
        float bottom = getHeight() - getPaddingBottom();
        float availableWidth = right - left;
        float availableHeight = bottom - top;
        if (availableWidth < 32f * density || availableHeight < 32f * density) {
            return;
        }

        // 竖屏取 3:4（宽:高），横屏取 4:3。
        float ratio = getHeight() > getWidth() ? 3f / 4f : 4f / 3f;
        float width = availableWidth;
        float height = availableHeight;
        if (width / height > ratio) {
            width = height * ratio;
        } else {
            height = width / ratio;
        }

        float centerX = left + availableWidth / 2f;
        float centerY = top + availableHeight / 2f;
        frame.set(centerX - width / 2f, centerY - height / 2f,
                centerX + width / 2f, centerY + height / 2f);

        canvas.drawRoundRect(frame, 16f * density, 16f * density, paint);
    }
}
