package io.github.hafijbge.meshdrop.engine.guest;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** The guest page (copied from the Node engine's guest/page.ts by scripts/guest-page-java.ts) and its QR code. */
public final class GuestPage {
    public static final String HTML = load("page.html");
    public static final String JS = load("app.js");
    public static final String CSS = load("app.css");

    private GuestPage() {}

    private static String load(String name) {
        try (InputStream in = GuestPage.class.getResourceAsStream(name)) {
            if (in == null) throw new IllegalStateException("missing resource " + name);
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
            return b.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** `text` as an SVG QR code (one quiet module around it, like the desktop's). */
    public static String qrSvg(String text) {
        BitMatrix m;
        try {
            Map<EncodeHintType, Object> hints = new java.util.EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.MARGIN, 1);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints);
        } catch (WriterException e) {
            throw new IllegalArgumentException("cannot make a QR code: " + e.getMessage());
        }
        int w = m.getWidth();
        int h = m.getHeight();
        StringBuilder p = new StringBuilder();
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (!m.get(x, y)) continue;
                int run = 1;
                while (x + run < w && m.get(x + run, y)) run++;
                p.append('M').append(x).append(' ').append(y).append('h').append(run).append("v1h-").append(run).append('z');
                x += run - 1;
            }
        }
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " + w + " " + h + "\" shape-rendering=\"crispEdges\">"
                + "<path fill=\"#ffffff\" d=\"M0 0h" + w + "v" + h + "H0z\"/><path stroke=\"none\" fill=\"#000000\" d=\"" + p + "\"/></svg>";
    }
}
