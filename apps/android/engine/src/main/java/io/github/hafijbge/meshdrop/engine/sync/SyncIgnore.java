package io.github.hafijbge.meshdrop.engine.sync;

import java.util.regex.Pattern;

/** Folder sync: names that are never synced (sync/ignore.ts). */
public final class SyncIgnore {
    private static final Pattern[] IGNORED = {
        Pattern.compile("^\\.meshdrop-.*"), Pattern.compile(".*\\.part$"), Pattern.compile("^~\\$.*"), Pattern.compile("^\\.~lock\\..*"),
        Pattern.compile("^\\.DS_Store$"), Pattern.compile("^(?i)Thumbs\\.db$"), Pattern.compile("^(?i)desktop\\.ini$"),
    };

    private SyncIgnore() {}

    /** Removed files land here at the top of each synced folder (paths kept); never synced, emptied by hand. */
    public static final String DELETED_DIR = "Deleted";

    public static boolean ignored(String rel) {
        if (rel.equals(DELETED_DIR) || rel.startsWith(DELETED_DIR + "/")) return true;
        for (String seg : rel.split("/", -1)) for (Pattern p : IGNORED) if (p.matcher(seg).matches()) return true;
        return false;
    }
}
