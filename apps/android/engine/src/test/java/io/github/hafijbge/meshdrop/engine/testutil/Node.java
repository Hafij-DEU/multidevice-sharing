package io.github.hafijbge.meshdrop.engine.testutil;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Runs the Node engine's CLI (packages/core/src/cli.ts) for interop tests. */
public final class Node {
    public static final File CLI = new File(System.getProperty("meshdrop.repo"), "packages/core/src/cli.ts");

    public static final class Result {
        public final int code;
        public final String out;

        Result(int code, String out) {
            this.code = code;
            this.out = out;
        }
    }

    private Node() {}

    public static List<String> argv(String... args) {
        List<String> cmd = new ArrayList<>();
        cmd.add("node");
        cmd.add(CLI.getPath());
        cmd.addAll(Arrays.asList(args));
        return cmd;
    }

    /** Runs a one-shot CLI command (stdout + stderr merged), with a timeout. */
    public static Result run(long timeoutSec, String... args) throws IOException, InterruptedException {
        Process p = new ProcessBuilder(argv(args)).redirectErrorStream(true).start();
        if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException("node " + String.join(" ", args) + " timed out");
        }
        return new Result(p.exitValue(), new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
    }

    public static Result run(String... args) throws IOException, InterruptedException {
        return run(60, args);
    }
}
