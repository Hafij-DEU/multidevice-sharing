package io.github.hafijbge.meshdrop.engine.testutil;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A `meshdrop listen` child process (the Node receiver) on its own home. */
public final class NodeListen implements AutoCloseable {
    public final File home;
    public final File inbox;
    public final int port;
    public final String deviceId;
    private final Process proc;
    private final StringBuffer out = new StringBuffer();

    private NodeListen(File home, int port, boolean discovery) throws IOException, InterruptedException {
        this.home = home;
        this.inbox = new File(home, "inbox");
        java.util.List<String> args = new java.util.ArrayList<>(java.util.List.of("listen", "--home", home.getPath(), "--inbox", inbox.getPath(), "--backup-dir", new File(home, "backup").getPath(), "--port", String.valueOf(port), "--alias", "pc"));
        if (!discovery) args.add("--no-discovery");
        proc = new ProcessBuilder(Node.argv(args.toArray(new String[0]))).redirectErrorStream(true).start();
        Thread t = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = r.readLine()) != null; ) out.append(line).append('\n');
            } catch (IOException ignored) {
                // process gone
            }
        });
        t.setDaemon(true);
        t.start();
        Pattern p = Pattern.compile("listening on port (\\d+)[\\s\\S]*device id ([0-9a-f]{64})");
        for (int i = 0; i < 400; i++) {
            Matcher m = p.matcher(out);
            if (m.find()) {
                this.port = Integer.parseInt(m.group(1));
                this.deviceId = m.group(2);
                return;
            }
            if (!proc.isAlive()) break;
            Thread.sleep(25);
        }
        proc.destroyForcibly();
        throw new IOException("listen did not start: " + out);
    }

    public static NodeListen start(File home) throws IOException, InterruptedException {
        return new NodeListen(home, 0, false);
    }

    public static NodeListen start(File home, int port) throws IOException, InterruptedException {
        return new NodeListen(home, port, false);
    }

    public static NodeListen startWithDiscovery(File home) throws IOException, InterruptedException {
        return new NodeListen(home, 0, true);
    }

    public String output() {
        return out.toString();
    }

    public boolean isAlive() {
        return proc.isAlive();
    }

    /** SIGKILL: a crash, not a clean stop. */
    public void kill() throws InterruptedException {
        proc.destroyForcibly();
        proc.waitFor(10, TimeUnit.SECONDS);
    }

    @Override
    public void close() throws InterruptedException {
        proc.destroy();
        if (!proc.waitFor(10, TimeUnit.SECONDS)) proc.destroyForcibly();
    }
}
