package io.github.hafijbge.meshdrop.engine.util;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** File helpers that exist on Android 10 (Files.readString is Java 11 and missing there). */
public final class Io {
    private Io() {}

    public static String readString(Path p) throws IOException {
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }
}
