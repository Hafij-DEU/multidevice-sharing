package io.github.hafijbge.meshdrop.engine.util;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.Test;

public class JsonTest {
    static Path repo() {
        return Path.of(System.getProperty("meshdrop.repo"));
    }

    /** Test-only: sorts object keys by UTF-16 code unit, so stringify can be compared with canonical-v1. */
    @SuppressWarnings("unchecked")
    static Object sorted(Object v) {
        if (v instanceof Map) {
            Map<String, Object> out = new TreeMap<>();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) out.put(e.getKey(), sorted(e.getValue()));
            return new LinkedHashMap<>(out);
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object x : (List<Object>) v) out.add(sorted(x));
            return out;
        }
        return v;
    }

    @Test
    @SuppressWarnings("unchecked")
    public void stringifyMatchesCanonicalVectorEscaping() throws Exception {
        String file = Files.readString(repo().resolve("protocol/vectors/canonical-v1.json"));
        Map<String, Object> v = (Map<String, Object>) Json.parse(file);
        int n = 0;
        for (Object o : (List<Object>) v.get("cases")) {
            Map<String, Object> c = (Map<String, Object>) o;
            String got = Json.stringify(sorted(c.get("input")));
            assertEquals((String) c.get("name"), c.get("canonical"), got);
            assertArrayEquals((String) c.get("name"), Hex.parse((String) c.get("canonicalHex")), got.getBytes(StandardCharsets.UTF_8));
            n++;
        }
        assertTrue(n >= 10);
    }

    @Test
    public void roundTripsInInsertionOrder() {
        String s = "{\"b\":1,\"a\":[true,null,\"x\",-2.5]}";
        assertEquals(s, Json.stringify(Json.parse(s)));
    }

    @Test
    public void loneSurrogateIsEscapedLowerCase() {
        assertEquals("\"\\ud800\"", Json.stringify("\ud800"));
        assertEquals("\"\\udc00a\"", Json.stringify("\udc00a"));
        assertEquals("\"\ud83d\ude00\"", Json.stringify("\ud83d\ude00"));
    }

    @Test
    public void controlsAndQuotesEscapedLikeJavaScript() {
        assertEquals("\"\\\"\\\\/\\b\\f\\n\\r\\t\\u0000\\u001f\u2028\"", Json.stringify("\"\\/\b\f\n\r\t\u0000\u001f\u2028"));
    }

    @Test
    public void numbers() {
        assertEquals(Long.valueOf(9007199254740991L), Json.parse("9007199254740991"));
        assertTrue(Json.parse("9007199254740993") instanceof Double);
        assertEquals(Long.valueOf(-42), Json.parse("-42"));
        assertEquals("1", Json.stringify(1L));
        assertEquals("1", Json.stringify(1));
        assertEquals("0.5", Json.stringify(0.5));
        assertEquals("0", Json.stringify(-0.0));
        assertThrows(Json.JsonException.class, () -> Json.parse("1e400"));
        assertThrows(Json.JsonException.class, () -> Json.stringify(Double.NaN));
    }

    @Test
    public void rejectsBadInput() {
        StringBuilder deep = new StringBuilder();
        for (int i = 0; i < 65; i++) deep.append('[');
        for (int i = 0; i < 65; i++) deep.append(']');
        assertThrows(Json.JsonException.class, () -> Json.parse(deep.toString()));
        for (String bad : new String[] {"", "{", "[1,]", "{\"a\":1,}", "tru", "\"\\x\"", "01", "1 2", "{\"a\" 1}", "\"\u0001\""}) {
            assertThrows(bad, Json.JsonException.class, () -> Json.parse(bad));
        }
    }

    @Test
    public void unicodeEscapesParse() {
        assertEquals("é😀\ud800", Json.parse("\"\\u00e9\\ud83d\\ude00\\ud800\""));
    }

    @Test
    public void base64AndHex() {
        byte[] b = {(byte) 0xfb, (byte) 0xff, 0x00, 0x01};
        assertEquals("+/8AAQ==", B64.std(b));
        assertEquals("-_8AAQ", B64.url(b));
        assertArrayEquals(b, B64.stdDecode("+/8AAQ=="));
        assertArrayEquals(b, B64.urlDecode("-_8AAQ"));
        assertThrows(IllegalArgumentException.class, () -> B64.stdDecode("+/8AAQ"));
        assertEquals("fbff0001", Hex.of(b));
        assertArrayEquals(b, Hex.parse("FBff0001"));
        assertThrows(IllegalArgumentException.class, () -> Hex.parse("abc"));
    }

    @Test
    public void nonAsciiDigitsAreRejectedAsJsonErrors() {
        for (String bad : new String[] {"1.\u0663", "\u0663", "1e\u0663", "-\u0663", "1\u0663"}) {
            assertThrows(bad, Json.JsonException.class, () -> Json.parse(bad));
        }
    }
}
