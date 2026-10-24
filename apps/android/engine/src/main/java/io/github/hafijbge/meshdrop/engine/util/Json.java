package io.github.hafijbge.meshdrop.engine.util;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON for the engine. Objects parse to LinkedHashMap (insertion order kept), arrays to
 * ArrayList, integers within ±(2^53−1) to Long, other numbers to Double. stringify escapes exactly
 * like ECMAScript JSON.stringify (the protocol's manifest and canonical JSON depend on it).
 */
public final class Json {
    public static final int MAX_DEPTH = 64;
    public static final int MAX_CHARS = 64 * 1024 * 1024;
    private static final long MAX_SAFE = 9007199254740991L;

    public static final class JsonException extends RuntimeException {
        public JsonException(String message) {
            super(message);
        }
    }

    private Json() {}

    // ---- parse ----------------------------------------------------------------------------------

    public static Object parse(String s) {
        if (s.length() > MAX_CHARS) throw new JsonException("too large");
        Parser p = new Parser(s);
        p.ws();
        Object v = p.value(0);
        p.ws();
        if (p.i != s.length()) throw new JsonException("trailing data at " + p.i);
        return v;
    }

    private static final class Parser {
        final String s;
        int i;

        Parser(String s) {
            this.s = s;
        }

        void ws() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
                else break;
            }
        }

        JsonException err(String what) {
            return new JsonException(what + " at " + i);
        }

        Object value(int depth) {
            if (depth > MAX_DEPTH) throw err("too deep");
            if (i >= s.length()) throw err("unexpected end");
            char c = s.charAt(i);
            switch (c) {
                case '{':
                    return object(depth + 1);
                case '[':
                    return array(depth + 1);
                case '"':
                    return string();
                case 't':
                    return literal("true", Boolean.TRUE);
                case 'f':
                    return literal("false", Boolean.FALSE);
                case 'n':
                    return literal("null", null);
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return number();
                    throw err("unexpected character");
            }
        }

        Object literal(String word, Object v) {
            if (!s.startsWith(word, i)) throw err("bad literal");
            i += word.length();
            return v;
        }

        Map<String, Object> object(int depth) {
            if (depth > MAX_DEPTH) throw err("too deep");
            i++;
            Map<String, Object> m = new LinkedHashMap<>();
            ws();
            if (i < s.length() && s.charAt(i) == '}') {
                i++;
                return m;
            }
            for (;;) {
                ws();
                if (i >= s.length() || s.charAt(i) != '"') throw err("expected key");
                String k = string();
                ws();
                if (i >= s.length() || s.charAt(i) != ':') throw err("expected :");
                i++;
                ws();
                m.put(k, value(depth));
                ws();
                if (i >= s.length()) throw err("unexpected end");
                char c = s.charAt(i++);
                if (c == '}') return m;
                if (c != ',') throw err("expected , or }");
            }
        }

        List<Object> array(int depth) {
            if (depth > MAX_DEPTH) throw err("too deep");
            i++;
            List<Object> a = new ArrayList<>();
            ws();
            if (i < s.length() && s.charAt(i) == ']') {
                i++;
                return a;
            }
            for (;;) {
                ws();
                a.add(value(depth));
                ws();
                if (i >= s.length()) throw err("unexpected end");
                char c = s.charAt(i++);
                if (c == ']') return a;
                if (c != ',') throw err("expected , or ]");
            }
        }

        String string() {
            i++; // opening quote
            StringBuilder b = new StringBuilder();
            for (;;) {
                if (i >= s.length()) throw err("unterminated string");
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c < 0x20) throw err("control character in string");
                if (c != '\\') {
                    b.append(c);
                    continue;
                }
                if (i >= s.length()) throw err("unterminated escape");
                char e = s.charAt(i++);
                switch (e) {
                    case '"': b.append('"'); break;
                    case '\\': b.append('\\'); break;
                    case '/': b.append('/'); break;
                    case 'b': b.append('\b'); break;
                    case 'f': b.append('\f'); break;
                    case 'n': b.append('\n'); break;
                    case 'r': b.append('\r'); break;
                    case 't': b.append('\t'); break;
                    case 'u':
                        if (i + 4 > s.length()) throw err("bad \\u escape");
                        int cp = 0;
                        for (int k = 0; k < 4; k++) {
                            int d = Character.digit(s.charAt(i + k), 16);
                            if (d < 0) throw err("bad \\u escape");
                            cp = cp * 16 + d;
                        }
                        i += 4;
                        b.append((char) cp);
                        break;
                    default:
                        throw err("bad escape");
                }
            }
        }

        Object number() {
            int start = i;
            if (s.charAt(i) == '-') i++;
            if (i >= s.length()) throw err("bad number");
            if (s.charAt(i) == '0') {
                i++;
            } else if (s.charAt(i) >= '1' && s.charAt(i) <= '9') {
                while (i < s.length() && isDigit(s.charAt(i))) i++;
            } else {
                throw err("bad number");
            }
            boolean integer = true;
            if (i < s.length() && s.charAt(i) == '.') {
                integer = false;
                i++;
                int d = i;
                while (i < s.length() && isDigit(s.charAt(i))) i++;
                if (i == d) throw err("bad fraction");
            }
            if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                integer = false;
                i++;
                if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
                int d = i;
                while (i < s.length() && isDigit(s.charAt(i))) i++;
                if (i == d) throw err("bad exponent");
            }
            String t = s.substring(start, i);
            try {
                if (integer && t.length() <= 17) {
                    long v = Long.parseLong(t);
                    if (Math.abs(v) <= MAX_SAFE) return v;
                }
                double d = Double.parseDouble(t);
                if (Double.isInfinite(d)) throw err("number out of range");
                return d;
            } catch (NumberFormatException e) {
                throw err("bad number");
            }
        }

        /** ASCII digits only (Character.isDigit also accepts other scripts' digits). */
        private static boolean isDigit(char c) {
            return c >= '0' && c <= '9';
        }
    }

    // ---- stringify ------------------------------------------------------------------------------

    public static String stringify(Object v) {
        StringBuilder b = new StringBuilder();
        write(b, v, 0);
        return b.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder b, Object v, int depth) {
        if (depth > MAX_DEPTH) throw new JsonException("too deep");
        if (v == null) {
            b.append("null");
        } else if (v instanceof String) {
            quote(b, (String) v);
        } else if (v instanceof Boolean) {
            b.append(((Boolean) v) ? "true" : "false");
        } else if (v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte) {
            b.append(((Number) v).longValue());
        } else if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) throw new JsonException("not a finite number");
            if (d == Math.rint(d) && Math.abs(d) <= MAX_SAFE) b.append((long) d); // also -0 → 0
            else b.append(jsNumber(d));
        } else if (v instanceof Map) {
            b.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                if (!first) b.append(',');
                first = false;
                quote(b, e.getKey());
                b.append(':');
                write(b, e.getValue(), depth + 1);
            }
            b.append('}');
        } else if (v instanceof List) {
            b.append('[');
            boolean first = true;
            for (Object x : (List<Object>) v) {
                if (!first) b.append(',');
                first = false;
                write(b, x, depth + 1);
            }
            b.append(']');
        } else {
            throw new JsonException("cannot serialize " + v.getClass().getName());
        }
    }

    /** ECMAScript Number::toString for the non-integer doubles the engine emits (rare). */
    private static String jsNumber(double d) {
        String s = Double.toString(d);
        if (s.contains("E")) {
            // Java: 1.0E21 → JS: 1e+21; 1.0E-7 → 1e-7
            String[] p = s.split("E");
            String m = p[0].endsWith(".0") ? p[0].substring(0, p[0].length() - 2) : p[0];
            int exp = Integer.parseInt(p[1]);
            return m + "e" + (exp >= 0 ? "+" : "") + exp;
        }
        return s.endsWith(".0") ? s.substring(0, s.length() - 2) : s;
    }

    public static void quote(StringBuilder b, String s) {
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\b': b.append("\\b"); break;
                case '\f': b.append("\\f"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        hex4(b, c);
                    } else if (Character.isHighSurrogate(c)) {
                        if (i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                            b.append(c).append(s.charAt(++i));
                        } else {
                            hex4(b, c);
                        }
                    } else if (Character.isLowSurrogate(c)) {
                        hex4(b, c); // lone (a paired one was consumed above)
                    } else {
                        b.append(c);
                    }
            }
        }
        b.append('"');
    }

    private static void hex4(StringBuilder b, char c) {
        b.append("\\u");
        String h = Integer.toHexString(c);
        for (int k = h.length(); k < 4; k++) b.append('0');
        b.append(h);
    }
}
