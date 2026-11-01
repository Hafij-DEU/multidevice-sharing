package io.github.hafijbge.meshdrop.engine.app;

import io.github.hafijbge.meshdrop.engine.util.Json;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Notification and other native text in the interface language. The page loads the language's table
 * (English text → translation, the same locales/<code>.json the interface uses) and hands it over;
 * it is kept on disk so a background start (no page yet) speaks the same language. English is the
 * key and the fallback: t("From {name}", "name", alias).
 */
public final class Tr {
    private static final Pattern HOLE = Pattern.compile("\\{(\\w+)\\}");
    private static volatile Map<String, String> table = Collections.emptyMap();

    private Tr() {}

    /** Translates en; vars are name, value pairs filling its {name} placeholders. */
    public static String t(String en, Object... vars) {
        String s = table.getOrDefault(en, en);
        if (s.isEmpty()) s = en;
        if (vars.length == 0) return s;
        Map<String, String> v = new HashMap<>();
        for (int i = 0; i + 1 < vars.length; i += 2) v.put(String.valueOf(vars[i]), String.valueOf(vars[i + 1]));
        Matcher m = HOLE.matcher(s);
        StringBuilder b = new StringBuilder();
        while (m.find()) m.appendReplacement(b, Matcher.quoteReplacement(v.getOrDefault(m.group(1), m.group())));
        return m.appendTail(b).toString();
    }

    /** Takes a table from the page (strings only) and keeps it in file. */
    public static void set(Object parsed, File file) {
        Map<String, String> next = strings(parsed);
        table = next;
        try {
            File tmp = new File(file.getPath() + ".tmp");
            Files.write(tmp.toPath(), Json.stringify(next).getBytes(StandardCharsets.UTF_8));
            if (!tmp.renameTo(file)) Files.move(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception ignored) {
            // kept in memory for this run
        }
    }

    /** Loads the table kept by the last set; English when there is none. */
    public static void load(File file) {
        try {
            table = strings(Json.parse(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)));
        } catch (Exception ignored) {
            table = Collections.emptyMap();
        }
    }

    private static Map<String, String> strings(Object parsed) {
        Map<String, String> out = new HashMap<>();
        if (parsed instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) parsed).entrySet()) {
                if (e.getKey() instanceof String && e.getValue() instanceof String) out.put((String) e.getKey(), (String) e.getValue());
            }
        }
        return Collections.unmodifiableMap(out);
    }
}
