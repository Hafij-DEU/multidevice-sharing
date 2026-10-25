package io.github.hafijbge.meshdrop.engine.util;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * M11 "phone as scanner": one JPEG photo as a one-page PDF (the JPEG is embedded as it is, DCTDecode),
 * sized to A4 width with the photo's aspect. No library needed.
 */
public final class JpegPdf {
    private JpegPdf() {}

    /** {width, height} from the JPEG's SOF marker. */
    static int[] size(byte[] j) throws IOException {
        if (j.length < 4 || (j[0] & 0xff) != 0xff || (j[1] & 0xff) != 0xd8) throw new IOException("not a JPEG");
        int i = 2;
        while (i + 9 < j.length) {
            if ((j[i] & 0xff) != 0xff) throw new IOException("bad JPEG");
            int marker = j[i + 1] & 0xff;
            int len = ((j[i + 2] & 0xff) << 8) | (j[i + 3] & 0xff);
            boolean sof = marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc;
            if (sof) return new int[] {((j[i + 7] & 0xff) << 8) | (j[i + 8] & 0xff), ((j[i + 5] & 0xff) << 8) | (j[i + 6] & 0xff)};
            i += 2 + len;
        }
        throw new IOException("no image size in the JPEG");
    }

    public static byte[] fromJpeg(byte[] jpeg) throws IOException {
        int[] wh = size(jpeg);
        double pageW = 595.28; // A4 width in points
        double pageH = pageW * wh[1] / wh[0];
        String w = String.format(java.util.Locale.ROOT, "%.2f", pageW);
        String h = String.format(java.util.Locale.ROOT, "%.2f", pageH);
        ByteArrayOutputStream out = new ByteArrayOutputStream(jpeg.length + 1024);
        List<Integer> offsets = new ArrayList<>();
        write(out, "%PDF-1.4\n%âãÏÓ\n");
        offsets.add(out.size());
        write(out, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        offsets.add(out.size());
        write(out, "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
        offsets.add(out.size());
        write(out, "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + w + " " + h + "] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n");
        offsets.add(out.size());
        write(out, "4 0 obj\n<< /Type /XObject /Subtype /Image /Width " + wh[0] + " /Height " + wh[1] + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + jpeg.length + " >>\nstream\n");
        out.write(jpeg);
        write(out, "\nendstream\nendobj\n");
        String content = "q " + w + " 0 0 " + h + " 0 0 cm /Im0 Do Q";
        offsets.add(out.size());
        write(out, "5 0 obj\n<< /Length " + content.length() + " >>\nstream\n" + content + "\nendstream\nendobj\n");
        int xref = out.size();
        StringBuilder x = new StringBuilder("xref\n0 6\n0000000000 65535 f \n");
        for (int o : offsets) x.append(String.format(java.util.Locale.ROOT, "%010d 00000 n \n", o));
        x.append("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n").append(xref).append("\n%%EOF\n");
        write(out, x.toString());
        return out.toByteArray();
    }

    private static void write(ByteArrayOutputStream out, String s) {
        byte[] b = s.getBytes(StandardCharsets.ISO_8859_1);
        out.write(b, 0, b.length);
    }
}
