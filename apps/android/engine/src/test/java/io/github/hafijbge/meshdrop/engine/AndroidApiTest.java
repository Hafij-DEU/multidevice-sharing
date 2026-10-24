package io.github.hafijbge.meshdrop.engine;

import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.Test;

/**
 * The engine runs on Android 10 (API 29), whose java.* lacks the Java 9–11 additions. The JVM tests
 * cannot see that, so this test refuses them in the engine's main sources.
 */
public class AndroidApiTest {
    private static final Pattern FORBIDDEN = Pattern.compile(
            "Files\\.readString|Files\\.writeString|\\.readAllBytes\\(\\)|\\bPath\\.of\\(|\\bList\\.of\\(|\\bSet\\.of\\(|\\bMap\\.of\\(|\\bMap\\.entry\\("
                    + "|\\bMap\\.ofEntries\\(|\\.repeat\\(|HexFormat|\\.isBlank\\(\\)|\\.strip\\(\\)|\\.transferTo\\(|Optional\\.isEmpty|\\.orElseThrow\\(\\)"
                    // ByteBuffer's covariant clear()/flip()/limit()/position() (Java 9) are missing before API 34: call them on a Buffer.
                    + "|\\b(buf|buffer|bb)\\.(clear|flip|limit|position|rewind|mark|reset)\\(");

    @Test
    public void mainSourcesUseOnlyApisPresentOnAndroid29() throws IOException {
        Path main = Paths.get(System.getProperty("meshdrop.repo"), "apps/android/engine/src/main/java");
        List<String> hits = new ArrayList<>();
        try (Stream<Path> files = Files.walk(main)) {
            for (Path p : (Iterable<Path>) files.filter(f -> f.toString().endsWith(".java"))::iterator) {
                List<String> lines = Files.readAllLines(p, StandardCharsets.UTF_8);
                for (int i = 0; i < lines.size(); i++) {
                    String t = lines.get(i).trim();
                    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
                    Matcher m = FORBIDDEN.matcher(lines.get(i));
                    if (m.find()) hits.add(main.relativize(p) + ":" + (i + 1) + ": " + m.group());
                }
            }
        }
        assertTrue("Java 9+ APIs missing on Android 29:\n" + String.join("\n", hits), hits.isEmpty());
    }
}
