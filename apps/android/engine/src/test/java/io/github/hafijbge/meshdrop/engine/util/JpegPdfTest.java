package io.github.hafijbge.meshdrop.engine.util;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class JpegPdfTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void aPhotoBecomesAOnePagePdfThatToolsRead() throws Exception {
        java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(800, 1000, java.awt.image.BufferedImage.TYPE_INT_RGB);
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(img, "jpg", bo);
        byte[] jpeg = bo.toByteArray();
        assertArrayEquals(new int[] {800, 1000}, JpegPdf.size(jpeg));
        byte[] pdf = JpegPdf.fromJpeg(jpeg);
        File out = new File(tmp.getRoot(), "scan.pdf");
        Files.write(out.toPath(), pdf);
        assertTrue(new String(pdf, 0, 8, StandardCharsets.ISO_8859_1).startsWith("%PDF-1.4"));
        // pdfinfo (poppler) must read it: one page, A4 width (where poppler is installed)
        org.junit.Assume.assumeTrue(new File("/usr/bin/pdfinfo").canExecute());
        Process p = new ProcessBuilder("pdfinfo", out.getPath()).redirectErrorStream(true).start();
        String info = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(info, 0, p.waitFor());
        assertTrue(info, info.matches("(?s).*Pages:\\s+1\\b.*"));
        assertTrue(info, info.contains("595.28 x 744.1"));
    }
}
