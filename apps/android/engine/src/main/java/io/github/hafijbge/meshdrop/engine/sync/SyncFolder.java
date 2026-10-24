package io.github.hafijbge.meshdrop.engine.sync;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.function.Predicate;

/**
 * The synced folder, by "/"-separated relative paths (already checked with Sanitize.safeRelPath). A
 * plain directory on the JVM (PathSyncFolder), a folder the user picked with the system picker on
 * Android (SAF). Only regular files count: symlinks and special files are never followed or listed.
 */
public interface SyncFolder {
    final class Entry {
        public final String rel;
        public final long size;
        /** Whole milliseconds. */
        public final long mtime;

        public Entry(String rel, long size, long mtime) {
            this.rel = rel;
            this.size = size;
            this.mtime = mtime;
        }
    }

    /** Every regular file; folders whose relative path `skip` accepts are not entered. */
    List<Entry> list(Predicate<String> skip) throws IOException;

    /** The file at `rel`, or null when there is none (or it is not a regular file). */
    Entry stat(String rel) throws IOException;

    InputStream open(String rel) throws IOException;

    /** The size of a partial download (by name, in .meshdrop-partial), or -1. */
    long partialSize(String name) throws IOException;

    OutputStream writePartial(String name, boolean append) throws IOException;

    InputStream openPartial(String name) throws IOException;

    void deletePartial(String name) throws IOException;

    /** Moves a finished partial to `rel` (parents created; `rel` must be free) with modification time `mtime`. */
    void commitPartial(String name, String rel, long mtime) throws IOException;

    /** Renames `rel` to `dest` inside the folder (parents created; `dest` must be free). */
    void move(String rel, String dest) throws IOException;

    boolean exists(String rel) throws IOException;

    /** Deletes trash rounds (.meshdrop-trash/<round>) last changed before `cutoffMs`. */
    void pruneTrash(long cutoffMs) throws IOException;

    /** How the app names this folder (a path, or a content URI). */
    String ref();
}
