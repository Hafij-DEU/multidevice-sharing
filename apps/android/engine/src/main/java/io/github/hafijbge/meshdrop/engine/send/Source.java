package io.github.hafijbge.meshdrop.engine.send;

import java.io.IOException;
import java.nio.channels.SeekableByteChannel;
import java.util.List;

/** A file the user picked: a JVM path or, on Android, a content URI. Read by position, never whole. */
public interface Source {
    /** Base name sent as the file name. */
    String name();

    long size() throws IOException;

    /** Modification time (ms); 0 when the platform cannot tell (then only chunk hashes guard changes). */
    long lastModified() throws IOException;

    SeekableByteChannel open() throws IOException;

    String mime();

    /** A persistable reference (path or URI) that a Resolver turns back into this source after a restart. */
    String ref();

    /** Re-opens sources from their refs (outbox resume). */
    interface Resolver {
        Source resolve(String ref) throws IOException;
    }

    /** A folder: its files (relative paths below the folder) and its empty directories. */
    interface Tree {
        String name();

        /** A persistable reference for the folder (path or tree URI), used to recognise the same send again. */
        String ref();

        /** Files in a stable order (sorted by name at each level); symlinks and special files skipped. */
        List<Entry> files() throws IOException;

        /** Directories (relative, "/"-separated) that hold no files or dirs; "" means the folder itself is empty. */
        List<String> emptyDirs() throws IOException;
    }

    final class Entry {
        public final String relPath;
        public final Source source;

        public Entry(String relPath, Source source) {
            this.relPath = relPath;
            this.source = source;
        }
    }
}
