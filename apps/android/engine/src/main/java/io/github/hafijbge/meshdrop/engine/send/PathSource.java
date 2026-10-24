package io.github.hafijbge.meshdrop.engine.send;

import java.io.IOException;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Sources on the local file system (JVM tests, and plain files on Android). */
public final class PathSource implements Source {
    private static final Map<String, String> MIME = new java.util.HashMap<>();

    static {
        String[] pairs = {
            ".txt", "text/plain", ".md", "text/markdown", ".html", "text/html", ".htm", "text/html", ".css", "text/css",
            ".csv", "text/csv", ".json", "application/json", ".js", "text/javascript", ".xml", "application/xml",
            ".pdf", "application/pdf", ".zip", "application/zip", ".gz", "application/gzip", ".tar", "application/x-tar",
            ".png", "image/png", ".jpg", "image/jpeg", ".jpeg", "image/jpeg", ".gif", "image/gif", ".webp", "image/webp",
            ".svg", "image/svg+xml", ".heic", "image/heic", ".mp3", "audio/mpeg", ".ogg", "audio/ogg", ".wav", "audio/wav",
            ".flac", "audio/flac", ".mp4", "video/mp4", ".mkv", "video/x-matroska", ".webm", "video/webm", ".mov", "video/quicktime",
            ".apk", "application/vnd.android.package-archive", ".deb", "application/vnd.debian.binary-package",
        };
        for (int i = 0; i < pairs.length; i += 2) MIME.put(pairs[i], pairs[i + 1]);
    }

    public static final Resolver RESOLVER = ref -> new PathSource(java.nio.file.Paths.get(ref));

    private final Path path;

    private PathSource(Path path) {
        this.path = path.toAbsolutePath().normalize();
    }

    public static PathSource file(Path p) {
        return new PathSource(p);
    }

    public static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "application/octet-stream" : MIME.getOrDefault(name.substring(dot).toLowerCase(Locale.ROOT), "application/octet-stream");
    }

    @Override
    public String name() {
        return path.getFileName().toString();
    }

    @Override
    public long size() throws IOException {
        return Files.size(path);
    }

    @Override
    public long lastModified() throws IOException {
        return Files.getLastModifiedTime(path).toMillis();
    }

    @Override
    public SeekableByteChannel open() throws IOException {
        if (!Files.isRegularFile(path)) throw new IOException("not a regular file: " + path);
        return Files.newByteChannel(path, StandardOpenOption.READ);
    }

    @Override
    public String mime() {
        return mimeOf(name());
    }

    @Override
    public String ref() {
        return path.toString();
    }

    /** A folder walked like the Node sender: sorted, symlinks and special files skipped. */
    public static Tree tree(Path root) {
        Path abs = root.toAbsolutePath().normalize();
        return new Tree() {
            @Override
            public String name() {
                return abs.getFileName().toString();
            }

            @Override
            public String ref() {
                return abs.toString();
            }

            @Override
            public List<Entry> files() throws IOException {
                List<Entry> out = new ArrayList<>();
                walk(abs, "", out, new ArrayList<>());
                return out;
            }

            @Override
            public List<String> emptyDirs() throws IOException {
                List<String> dirs = new ArrayList<>();
                walk(abs, "", new ArrayList<>(), dirs);
                return dirs;
            }
        };
    }

    private static void walk(Path dir, String rel, List<Entry> files, List<String> empty) throws IOException {
        List<Path> kids = new ArrayList<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) kids.add(p);
        }
        kids.sort((a, b) -> a.getFileName().toString().compareTo(b.getFileName().toString()));
        int emitted = 0;
        for (Path k : kids) {
            if (Files.isSymbolicLink(k)) continue;
            String childRel = rel.isEmpty() ? k.getFileName().toString() : rel + "/" + k.getFileName();
            if (Files.isDirectory(k, LinkOption.NOFOLLOW_LINKS)) {
                walk(k, childRel, files, empty);
                emitted++;
            } else if (Files.isRegularFile(k, LinkOption.NOFOLLOW_LINKS)) {
                files.add(new Entry(childRel, new PathSource(k)));
                emitted++;
            }
        }
        if (emitted == 0) empty.add(rel);
    }
}
