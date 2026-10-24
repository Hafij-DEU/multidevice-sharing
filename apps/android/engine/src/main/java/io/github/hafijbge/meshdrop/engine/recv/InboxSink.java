package io.github.hafijbge.meshdrop.engine.recv;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;

/**
 * Where finished files land, by inbox-relative path ("/"-separated, already sanitized): a plain
 * directory on the JVM (DirectorySink), MediaStore Download/MeshDrop on Android.
 */
public interface InboxSink {
    enum Kind { NONE, DIR, FILE, OTHER }

    /** What is at `rel` (OTHER: a symlink or special file, never followed). */
    Kind kind(String rel) throws IOException;

    /** Creates the directories of `relDir` ("" = the root); refuses to go through a symlink. */
    void mkdirs(String relDir) throws IOException;

    /** Moves `data` to `rel` unless that name is taken; returns the landed path, or null if taken. */
    String publishAs(String rel, File data, String mime) throws IOException;

    /** Reads a landed file (crash recovery verifies its hash), or null if there is none. */
    InputStream open(String rel) throws IOException;
}
