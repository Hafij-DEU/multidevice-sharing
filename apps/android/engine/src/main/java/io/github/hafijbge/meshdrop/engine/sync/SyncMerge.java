package io.github.hafijbge.meshdrop.engine.sync;

import java.util.Calendar;
import java.util.Locale;

/**
 * Folder sync: the three-way decision for one path (sync/merge.ts). Versions are content hashes; null
 * means the file is not there. A change beats a delete; between two changes the newer mtime wins (tie:
 * the larger device id) and only the losing side acts, keeping its own as a conflict copy.
 */
public final class SyncMerge {
    public enum Kind { AGREE, TAKE, CONFLICT_TAKE, KEEP }

    public static final class Decision {
        public final Kind kind;
        /** The new base (AGREE/TAKE/CONFLICT_TAKE). */
        public final String base;

        Decision(Kind kind, String base) {
            this.kind = kind;
            this.base = base;
        }
    }

    private SyncMerge() {}

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    public static Decision decide(String l, long lMtime, String r, long rMtime, String base, String localId, String remoteId) {
        if (eq(l, r)) return new Decision(Kind.AGREE, l);
        if (eq(l, base)) return new Decision(Kind.TAKE, r);
        if (eq(r, base)) return new Decision(Kind.KEEP, null);
        if (l == null) return new Decision(Kind.TAKE, r);
        if (r == null) return new Decision(Kind.KEEP, null);
        boolean remoteWins = rMtime > lMtime || (rMtime == lMtime && remoteId.compareTo(localId) > 0);
        return remoteWins ? new Decision(Kind.CONFLICT_TAKE, r) : new Decision(Kind.KEEP, null);
    }

    /** "photo (conflict from Phone 2026-10-24 21-30).jpg". */
    public static String conflictName(String name, String alias, long atMs) {
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(atMs);
        String when = String.format(Locale.ROOT, "%04d-%02d-%02d %02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH),
                c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE));
        String who = alias.replaceAll("[/\\\\\\u0000-\\u001f]", "_");
        if (who.length() > 40) who = who.substring(0, 40);
        return stem + " (conflict from " + who + " " + when + ")" + ext;
    }
}
