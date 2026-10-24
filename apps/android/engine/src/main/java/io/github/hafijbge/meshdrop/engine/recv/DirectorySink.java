package io.github.hafijbge.meshdrop.engine.recv;

import io.github.hafijbge.meshdrop.engine.proto.Sanitize;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;

/** An InboxSink over a plain directory: hard link (never overwrites), else a checked rename. */
public final class DirectorySink implements InboxSink {
    private final File root;

    public DirectorySink(File root) {
        this.root = root;
    }

    private Path path(String rel) {
        return rel.isEmpty() ? root.toPath() : root.toPath().resolve(rel);
    }

    @Override
    public Kind kind(String rel) {
        Path p = path(rel);
        if (Files.isSymbolicLink(p)) return Kind.OTHER;
        if (!Files.exists(p, LinkOption.NOFOLLOW_LINKS)) return Kind.NONE;
        if (Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) return Kind.DIR;
        if (Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)) return Kind.FILE;
        return Kind.OTHER;
    }

    @Override
    public void mkdirs(String relDir) throws IOException {
        Files.createDirectories(root.toPath());
        Path cur = root.toPath();
        if (relDir.isEmpty()) return;
        for (String part : relDir.split("/")) {
            cur = cur.resolve(part);
            if (Files.isSymbolicLink(cur)) throw new Sanitize.UnsafePath("symlink in destination path");
            if (!Files.exists(cur, LinkOption.NOFOLLOW_LINKS)) {
                try {
                    Files.createDirectory(cur);
                } catch (FileAlreadyExistsException e) {
                    // raced with another session
                }
            }
            if (Files.isSymbolicLink(cur)) throw new Sanitize.UnsafePath("symlink in destination path");
            if (!Files.isDirectory(cur, LinkOption.NOFOLLOW_LINKS)) throw new IOException(cur + " exists and is not a directory");
        }
    }

    @Override
    public String publishAs(String rel, File data, String mime) throws IOException {
        Path target = path(rel);
        try {
            Files.createLink(target, data.toPath()); // atomic, never overwrites
        } catch (FileAlreadyExistsException e) {
            return null;
        } catch (UnsupportedOperationException | IOException e) {
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) return null;
            Files.move(data.toPath(), target);
            return rel;
        }
        Files.deleteIfExists(data.toPath());
        return rel;
    }

    @Override
    public InputStream open(String rel) throws IOException {
        File f = path(rel).toFile();
        return f.isFile() && !Files.isSymbolicLink(f.toPath()) ? new FileInputStream(f) : null;
    }
}
