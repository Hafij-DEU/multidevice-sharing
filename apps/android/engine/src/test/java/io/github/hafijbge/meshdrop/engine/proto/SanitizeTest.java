package io.github.hafijbge.meshdrop.engine.proto;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

/** Same cases as packages/core/test/sanitize.test.ts. */
public class SanitizeTest {
    static int bl(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    static String rep(String s, int n) {
        return s.repeat(n);
    }

    static String join(String seg, int n) {
        return String.join("/", java.util.Collections.nCopies(n, seg));
    }

    @Test
    public void keepsNormalPathsAndNormalizesSeparators() {
        assertEquals("a/b.txt", Sanitize.safeRelPath("a/b.txt"));
        assertEquals("a/b.txt", Sanitize.safeRelPath("a\\b.txt"));
        assertEquals("a/b/c.txt", Sanitize.safeRelPath("./a//b/./c.txt"));
    }

    @Test
    public void rejectsTraversalAbsoluteDriveLettersNulDepth() {
        for (String bad : new String[] {"../x", "/etc/x", "\\\\server\\share", "C:\\x", "c:/x", "C:", "a/../../b", "a/..", "a\u0000b"}) {
            assertThrows(bad, Sanitize.UnsafePath.class, () -> Sanitize.safeRelPath(bad));
        }
        assertThrows(Sanitize.UnsafePath.class, () -> Sanitize.safeRelPath(join("d", 33)));
        assertEquals(join("d", 32), Sanitize.safeRelPath(join("d", 32)));
    }

    @Test
    public void replacesReservedCharactersAndPrefixesReservedWindowsNames() {
        assertEquals("_CON.txt", Sanitize.safeRelPath("CON.txt"));
        assertEquals("a/_lpt1.tar.gz", Sanitize.safeRelPath("a/lpt1.tar.gz"));
        assertEquals("a_b_.txt", Sanitize.safeRelPath("a:b?.txt"));
        assertEquals("x_y__z____", Sanitize.safeRelPath("x<y>\"z|*\u0001\u007f"));
        assertEquals("console.txt", Sanitize.safeRelPath("console.txt"));
    }

    @Test
    public void truncatesALongSegmentKeepingAShortExtension() {
        String seg = Sanitize.safeRelPath("a/" + rep("x", 300) + ".txt").split("/")[1];
        assertEquals(240, bl(seg));
        assertTrue(seg.endsWith(".txt"));
        assertTrue(seg.startsWith(rep("x", 236)));
    }

    @Test
    public void truncatesTheWholeSegmentWhenTheExtensionIsLongOrAbsent() {
        assertEquals(240, bl(Sanitize.safeRelPath(rep("y", 304))));
        assertEquals(240, bl(Sanitize.safeRelPath(rep("z", 250) + "." + rep("e", 20))));
    }

    @Test
    public void neverSplitsMultiByteCharactersOrSurrogatePairs() {
        for (String ch : new String[] {"\u00e9", "\u20ac", "\ud83d\ude00"}) {
            String out = Sanitize.safeRelPath(rep(ch, 200) + ".jpg");
            assertTrue(bl(out) <= 240);
            assertTrue(out.endsWith(".jpg"));
            assertEquals(out, new String(out.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8));
            assertFalse(out.contains("\ufffd"));
        }
        assertEquals("a_b", Sanitize.safeRelPath("a\ud800b"));
    }

    @Test
    public void rejectsARelativePathOver3072Bytes() {
        String seg = rep("p", 240);
        assertThrows(Sanitize.UnsafePath.class, () -> Sanitize.safeRelPath(join(seg, 13)));
        assertEquals(12 * 240 + 11, Sanitize.safeRelPath(join(seg, 12)).length());
    }

    @Test
    public void uniqueNameFollowsTheStemNExtPattern() {
        Set<String> taken = new HashSet<>();
        assertEquals("photo.jpg", Sanitize.uniqueName("photo.jpg", taken::contains));
        taken.add("photo.jpg");
        assertEquals("photo (1).jpg", Sanitize.uniqueName("photo.jpg", taken::contains));
        taken.add("photo (1).jpg");
        assertEquals("photo (2).jpg", Sanitize.uniqueName("photo.jpg", taken::contains));
        taken.add(".bashrc");
        assertEquals(".bashrc (1)", Sanitize.uniqueName(".bashrc", taken::contains));
        taken.add("a.tar.gz");
        assertEquals("a.tar (1).gz", Sanitize.uniqueName("a.tar.gz", taken::contains));
    }
}
