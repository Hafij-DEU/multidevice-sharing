package io.github.hafijbge.meshdrop.engine.guest;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Test;

/** Slow or crowding clients cannot hold the guest server's connection slots. */
public class GuestServerLimitsTest {
    private GuestServer server;
    private final List<Socket> socks = new ArrayList<>();

    @After
    public void stop() throws Exception {
        for (Socket s : socks) s.close();
        if (server != null) server.stop();
    }

    private int start(int headDeadlineMs) throws Exception {
        GuestServer.Options o = new GuestServer.Options();
        o.headDeadlineMs = headDeadlineMs;
        server = new GuestServer(o);
        return server.start(0);
    }

    private Socket open(int port) throws Exception {
        Socket s = new Socket("127.0.0.1", port);
        s.setSoTimeout(5000);
        socks.add(s);
        return s;
    }

    @Test
    public void aClientDrippingTheHeadIsClosedAtTheDeadline() throws Exception {
        int port = start(300);
        Socket s = open(port);
        OutputStream out = s.getOutputStream();
        out.write("GET /g/ HTTP/1.1\r\n".getBytes(StandardCharsets.US_ASCII));
        out.flush();
        long t0 = System.currentTimeMillis();
        InputStream in = s.getInputStream();
        int r;
        try {
            r = in.read();
        } catch (java.net.SocketException e) {
            r = -1;
        }
        assertEquals(-1, r);
        assertTrue("closed near the deadline", System.currentTimeMillis() - t0 < 3000);
    }

    @Test
    public void atMost16ConnectionsFromOneAddress() throws Exception {
        int port = start(10_000);
        for (int i = 0; i < 16; i++) open(port);
        Thread.sleep(200);
        Socket extra = open(port);
        int r;
        try {
            r = extra.getInputStream().read();
        } catch (java.net.SocketException e) {
            r = -1;
        }
        assertEquals("the 17th is closed at once", -1, r);
    }
}
