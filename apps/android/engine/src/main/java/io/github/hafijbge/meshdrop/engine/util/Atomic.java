package io.github.hafijbge.meshdrop.engine.util;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;

/** Crash-safe, owner-only file writes: temp file in the same directory, fsync, rename. */
public final class Atomic {
    private static final SecureRandom RNG = new SecureRandom();

    private Atomic() {}

    public static void write(File f, byte[] data) throws IOException {
        File dir = f.getAbsoluteFile().getParentFile();
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) throw new IOException("cannot create " + dir);
        File tmp = new File(dir, "." + f.getName() + "." + Long.toHexString(RNG.nextLong()) + ".tmp");
        try {
            if (!tmp.createNewFile()) throw new IOException("temp file exists: " + tmp);
            ownerOnly(tmp);
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(data);
                out.getFD().sync();
            }
            Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            if (tmp.exists() && !tmp.delete()) tmp.deleteOnExit();
        }
    }

    /** rw for the owner only (0600 on a POSIX file system). */
    public static void ownerOnly(File f) {
        f.setReadable(false, false);
        f.setWritable(false, false);
        f.setExecutable(false, false);
        f.setReadable(true, true);
        f.setWritable(true, true);
    }
}
