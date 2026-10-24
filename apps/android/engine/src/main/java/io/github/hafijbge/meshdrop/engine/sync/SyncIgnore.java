package io.github.hafijbge.meshdrop.engine.sync;

import java.util.regex.Pattern;

/** Folder sync: names that are never synced (sync/ignore.ts). */
public final class SyncIgnore {
    private static final Pattern[] IGNORED = {
        Pattern.compile("^\\.meshdrop-.*"), Pattern.compile(".*\\.part$"), Pattern.compile("^~\\$.*"), Pattern.compile("^\\.~lock\\..*"),
        Pattern.compile("^\\.DS_Store$"), Pattern.compile("^(?i)Thumbs\\.db$"), Pattern.compile("^(?i)desktop\\.ini$"),
    };

    private SyncIgnore() {}

    public static boolean ignored(String rel) {
        for (String seg : rel.split("/", -1)) for (Pattern p : IGNORED) if (p.matcher(seg).matches()) return true;
        return false;
    }
}
