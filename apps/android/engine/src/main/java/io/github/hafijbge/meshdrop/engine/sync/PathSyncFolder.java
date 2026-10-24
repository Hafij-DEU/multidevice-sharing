package io.github.hafijbge.meshdrop.engine.sync;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

/** A SyncFolder on a plain directory. */
public final class PathSyncFolder implements SyncFolder {
    private final Path root;

    public PathSyncFolder(Path root) throws IOException {
        this.root = root;
        Files.createDirectories(root);
    }

    private Path at(String rel) {
        return root.resolve(rel.replace('/', File.separatorChar));
    }

    private Path partial(String name) {
        return root.resolve(SyncRound.PARTIAL_DIR).resolve(name);
    }

    /** Creates the parents of `p` inside the root, refusing to go through anything but a real directory. */
    private void parents(Path p) throws IOException {
        Path cur = root;
        Path rel = root.relativize(p.getParent());
        for (Path part : rel) {
            if (part.toString().isEmpty()) continue;
            cur = cur.resolve(part);
            if (!Files.exists(cur, LinkOption.NOFOLLOW_LINKS)) Files.createDirectory(cur);
            else if (!Files.isDirectory(cur, LinkOption.NOFOLLOW_LINKS)) throw new IOException("not a folder: " + cur);
        }
    }

    @Override
    public List<Entry> list(Predicate<String> skip) throws IOException {
        List<Entry> out = new ArrayList<>();
        walk(root, "", skip, out);
        return out;
    }

    private void walk(Path dir, String prefix, Predicate<String> skip, List<Entry> out) throws IOException {
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) {
                String rel = prefix.isEmpty() ? p.getFileName().toString() : prefix + "/" + p.getFileName();
                if (skip.test(rel)) continue;
                BasicFileAttributes a;
                try {
                    a = Files.readAttributes(p, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                } catch (IOException e) {
                    continue;
                }
                if (a.isDirectory()) walk(p, rel, skip, out);
                else if (a.isRegularFile()) out.add(new Entry(rel, a.size(), a.lastModifiedTime().toMillis()));
            }
        }
    }

    @Override
    public Entry stat(String rel) {
        try {
            BasicFileAttributes a = Files.readAttributes(at(rel), BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            return a.isRegularFile() ? new Entry(rel, a.size(), a.lastModifiedTime().toMillis()) : null;
        } catch (IOException e) {
            return null;
        }
    }

    @Override
    public InputStream open(String rel) throws IOException {
        if (stat(rel) == null) throw new IOException("not a file: " + rel);
        return new FileInputStream(at(rel).toFile());
    }

    @Override
    public long partialSize(String name) {
        File f = partial(name).toFile();
        return f.isFile() ? f.length() : -1;
    }

    @Override
    public OutputStream writePartial(String name, boolean append) throws IOException {
        Files.createDirectories(partial(name).getParent());
        return new FileOutputStream(partial(name).toFile(), append);
    }

    @Override
    public InputStream openPartial(String name) throws IOException {
        return new FileInputStream(partial(name).toFile());
    }

    @Override
    public void deletePartial(String name) throws IOException {
        Files.deleteIfExists(partial(name));
    }

    @Override
    public void commitPartial(String name, String rel, long mtime) throws IOException {
        Path dest = at(rel);
        parents(dest);
        if (Files.exists(dest, LinkOption.NOFOLLOW_LINKS)) throw new IOException("taken: " + rel);
        Files.move(partial(name), dest);
        Files.setLastModifiedTime(dest, FileTime.fromMillis(mtime));
    }

    @Override
    public void move(String rel, String dest) throws IOException {
        Path d = at(dest);
        parents(d);
        if (Files.exists(d, LinkOption.NOFOLLOW_LINKS)) throw new IOException("taken: " + dest);
        Files.move(at(rel), d);
    }

    @Override
    public boolean exists(String rel) {
        return Files.exists(at(rel), LinkOption.NOFOLLOW_LINKS);
    }

    @Override
    public void pruneTrash(long cutoffMs) throws IOException {
        Path t = root.resolve(SyncRound.TRASH_DIR);
        if (!Files.isDirectory(t, LinkOption.NOFOLLOW_LINKS)) return;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(t)) {
            for (Path p : ds) if (Files.getLastModifiedTime(p, LinkOption.NOFOLLOW_LINKS).toMillis() < cutoffMs) deleteTree(p.toFile());
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.isDirectory() && !Files.isSymbolicLink(f.toPath()) ? f.listFiles() : null;
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    @Override
    public String ref() {
        return root.toString();
    }
}
