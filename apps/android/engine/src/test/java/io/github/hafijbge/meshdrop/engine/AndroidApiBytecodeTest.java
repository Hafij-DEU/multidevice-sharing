package io.github.hafijbge.meshdrop.engine;

import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.stream.Stream;
import javax.xml.parsers.SAXParserFactory;
import org.junit.Test;
import org.xml.sax.Attributes;
import org.xml.sax.helpers.DefaultHandler;

/**
 * Every java.* / javax.* method and class the engine's compiled code references must exist on
 * Android 29 (minSdk), per the SDK's api-versions.xml. A source regex cannot see these (lint does
 * not analyse the engine either: it consumes engine.jar), so the bytecode is checked directly.
 */
public class AndroidApiBytecodeTest {
    static final int MIN_SDK = 29;
    /** invokedynamic bootstraps that D8 desugars (lambdas, string concatenation). */
    static final java.util.Set<String> DESUGARED = new java.util.HashSet<>(java.util.Arrays.asList(
            "java/lang/invoke/LambdaMetafactory", "java/lang/invoke/StringConcatFactory"));

    static final class Cls {
        int since = 1;
        final List<String> supers = new ArrayList<>();
        final Map<String, Integer> methods = new HashMap<>();
    }

    static Map<String, Cls> api(File xml) throws Exception {
        Map<String, Cls> out = new HashMap<>();
        SAXParserFactory.newInstance().newSAXParser().parse(xml, new DefaultHandler() {
            Cls cur;

            @Override
            public void startElement(String uri, String local, String q, Attributes a) {
                switch (q) {
                    case "class":
                        cur = new Cls();
                        if (a.getValue("since") != null) cur.since = Integer.parseInt(a.getValue("since"));
                        out.put(a.getValue("name"), cur);
                        break;
                    case "extends":
                    case "implements":
                        if (cur != null && a.getValue("removed") == null) cur.supers.add(a.getValue("name"));
                        break;
                    case "method":
                        if (cur != null && a.getValue("removed") == null) {
                            String s = a.getValue("since");
                            cur.methods.put(a.getValue("name"), s == null ? cur.since : Integer.parseInt(s));
                        }
                        break;
                    default:
                        break;
                }
            }
        });
        return out;
    }

    /** The API level where `owner` (or a supertype) first has `nameDesc`, or -1 if never. */
    static int since(Map<String, Cls> api, String owner, String nameDesc) {
        Cls c = api.get(owner);
        if (c == null) return -1;
        Integer s = c.methods.get(nameDesc);
        if (s != null) return Math.max(s, c.since);
        int best = -1;
        for (String sup : c.supers) {
            int v = since(api, sup, nameDesc);
            if (v >= 0 && (best < 0 || v < best)) best = v;
        }
        return best < 0 ? -1 : Math.max(best, c.since);
    }

    /** (owner, name+descriptor) of every Methodref/InterfaceMethodref, and every Class constant. */
    static void refs(File classFile, List<String[]> methods, List<String> classes) throws IOException {
        try (DataInputStream in = new DataInputStream(new FileInputStream(classFile))) {
            in.readInt();
            in.readUnsignedShort();
            in.readUnsignedShort();
            int n = in.readUnsignedShort();
            Object[] cp = new Object[n];
            int[][] refs = new int[n][];
            int[] tags = new int[n];
            for (int i = 1; i < n; i++) {
                int tag = in.readUnsignedByte();
                tags[i] = tag;
                switch (tag) {
                    case 1: cp[i] = in.readUTF(); break;
                    case 3: case 4: in.readInt(); break;
                    case 5: case 6: in.readLong(); i++; break;
                    case 7: case 8: case 16: case 19: case 20: refs[i] = new int[] {in.readUnsignedShort()}; break;
                    case 9: case 10: case 11: case 12: case 17: case 18: refs[i] = new int[] {in.readUnsignedShort(), in.readUnsignedShort()}; break;
                    case 15: in.readUnsignedByte(); in.readUnsignedShort(); break;
                    default: throw new IOException("unknown constant tag " + tag + " in " + classFile);
                }
            }
            for (int i = 1; i < n; i++) {
                if (tags[i] == 7) classes.add((String) cp[refs[i][0]]);
                if (tags[i] == 10 || tags[i] == 11) {
                    String owner = (String) cp[refs[refs[i][0]][0]];
                    int[] nat = refs[refs[i][1]];
                    methods.add(new String[] {owner, cp[nat[0]] + "" + cp[nat[1]]});
                }
            }
        }
    }

    @Test
    public void engineBytecodeUsesOnlyApisPresentOnAndroid29() throws Exception {
        File xml = new File(System.getProperty("user.home"), "Android/Sdk/platforms/android-35/data/api-versions.xml");
        assumeTrue("needs the Android SDK's api-versions.xml", xml.isFile());
        Map<String, Cls> api = api(xml);
        Path classes = Paths.get(System.getProperty("meshdrop.repo"), "apps/android/engine/build/classes/java/main");
        TreeSet<String> bad = new TreeSet<>();
        try (Stream<Path> files = Files.walk(classes)) {
            for (Path p : (Iterable<Path>) files.filter(f -> f.toString().endsWith(".class"))::iterator) {
                List<String[]> methods = new ArrayList<>();
                List<String> cls = new ArrayList<>();
                refs(p.toFile(), methods, cls);
                String where = classes.relativize(p).toString();
                for (String c : cls) {
                    if (!(c.startsWith("java/") || c.startsWith("javax/")) || DESUGARED.contains(c)) continue;
                    Cls k = api.get(c);
                    if (k == null) bad.add(where + ": class " + c + " is not on Android");
                    else if (k.since > MIN_SDK) bad.add(where + ": class " + c + " needs API " + k.since);
                }
                for (String[] m : methods) {
                    if (!(m[0].startsWith("java/") || m[0].startsWith("javax/")) || DESUGARED.contains(m[0])) continue;
                    int s = since(api, m[0], m[1]);
                    if (s < 0) bad.add(where + ": " + m[0] + "." + m[1] + " is not on Android");
                    else if (s > MIN_SDK) bad.add(where + ": " + m[0] + "." + m[1] + " needs API " + s);
                }
            }
        }
        assertTrue("APIs above minSdk " + MIN_SDK + ":\n" + String.join("\n", bad), bad.isEmpty());
    }
}
