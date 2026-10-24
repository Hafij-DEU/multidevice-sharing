package io.github.hafijbge.meshdrop.engine.proto;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/** Receiver-side path sanitizing, exactly as packages/core/src/sanitize.ts. */
public final class Sanitize {
    public static final int MAX_PATH_SEGMENTS = 32;
    public static final int MAX_SEGMENT_BYTES = 240;
    private static final int MAX_EXT_BYTES = 16;
    public static final int MAX_PATH_BYTES = 3072;
    private static final Pattern DRIVE_LETTER = Pattern.compile("^[A-Za-z]:(?:[/\\\\]|$)");
    private static final Pattern RESERVED_STEM = Pattern.compile("^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$", Pattern.CASE_INSENSITIVE);

    public static final class UnsafePath extends RuntimeException {
        public UnsafePath(String message) {
            super(message);
        }
    }

    private Sanitize() {}

    static int byteLen(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    /** Longest prefix of `s` that is at most `max` UTF-8 bytes, cut on a code-point boundary. */
    private static String cutBytes(String s, int max) {
        StringBuilder out = new StringBuilder();
        int bytes = 0;
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            String ch = new String(Character.toChars(cp));
            int n = byteLen(ch);
            if (bytes + n > max) break;
            bytes += n;
            out.append(ch);
            i += Character.charCount(cp);
        }
        return out.toString();
    }

    private static String limitSegment(String seg) {
        if (byteLen(seg) <= MAX_SEGMENT_BYTES) return seg;
        int dot = seg.lastIndexOf('.');
        String ext = dot > 0 ? seg.substring(dot) : "";
        if (!ext.isEmpty() && byteLen(ext) <= MAX_EXT_BYTES) return cutBytes(seg.substring(0, dot), MAX_SEGMENT_BYTES - byteLen(ext)) + ext;
        return cutBytes(seg, MAX_SEGMENT_BYTES);
    }

    private static boolean badChar(char c) {
        return c == '<' || c == '>' || c == ':' || c == '"' || c == '|' || c == '?' || c == '*' || c < 0x20 || c == 0x7f;
    }

    /** `<>:"|?*`, controls, DEL and lone surrogates become '_' (per UTF-16 unit, like the JS regexes). */
    private static String clean(String raw) {
        StringBuilder b = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < raw.length() && Character.isLowSurrogate(raw.charAt(i + 1))) {
                b.append(c).append(raw.charAt(++i));
            } else if (Character.isSurrogate(c) || badChar(c)) {
                b.append('_');
            } else {
                b.append(c);
            }
        }
        return b.toString();
    }

    public static String safeRelPath(String p) {
        if (p == null) throw new UnsafePath("path must be a string");
        if (p.indexOf('\u0000') >= 0) throw new UnsafePath("path contains NUL");
        if (p.startsWith("/") || p.startsWith("\\")) throw new UnsafePath("absolute path");
        if (DRIVE_LETTER.matcher(p).find()) throw new UnsafePath("drive-letter path");
        List<String> segs = new ArrayList<>();
        for (String raw : p.split("[/\\\\]", -1)) {
            if (raw.isEmpty() || raw.equals(".")) continue;
            if (raw.equals("..")) throw new UnsafePath("path traversal");
            String seg = clean(raw);
            int dot = seg.indexOf('.');
            String stem = dot == -1 ? seg : seg.substring(0, dot);
            if (RESERVED_STEM.matcher(stem).matches()) seg = "_" + seg;
            segs.add(limitSegment(seg));
        }
        if (segs.size() > MAX_PATH_SEGMENTS) throw new UnsafePath("path too deep");
        String rel = String.join("/", segs);
        if (byteLen(rel) > MAX_PATH_BYTES) throw new UnsafePath("path too long");
        return rel;
    }

    /** `name`, or `stem (n).ext` for the smallest n >= 1 that `taken` says is free. */
    public static String uniqueName(String name, Predicate<String> taken) {
        int dot = name.lastIndexOf('.');
        String stem = dot <= 0 ? name : name.substring(0, dot);
        String ext = dot <= 0 ? "" : name.substring(dot);
        for (int n = 0; ; n++) {
            String candidate = n == 0 ? name : stem + " (" + n + ")" + ext;
            if (!taken.test(candidate)) return candidate;
        }
    }
}
