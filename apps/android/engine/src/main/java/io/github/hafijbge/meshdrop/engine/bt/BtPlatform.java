package io.github.hafijbge.meshdrop.engine.bt;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;

/**
 * What a platform gives the link manager (M14): paired devices and RFCOMM byte streams. Android wraps
 * BluetoothSocket; tests use socket pairs. Everything above the bytes is in BtLinks and BtLink.
 */
public interface BtPlatform {
    /** The MeshDrop RFCOMM service UUID (SDP record on both platforms). */
    String SERVICE_UUID = "6d657368-6472-6f70-0001-000000000001";

    /** A paired device. */
    final class Bonded {
        public final String address;
        public final String name;

        public Bonded(String address, String name) {
            this.address = address;
            this.name = name;
        }
    }

    /** One RFCOMM connection; close() ends it. */
    interface Conn extends Closeable {
        InputStream in() throws IOException;

        OutputStream out() throws IOException;
    }

    interface Acceptor {
        /** An incoming connection from `address`; must not block for long. */
        void accept(Conn conn, String address);
    }

    List<Bonded> bonded() throws IOException;

    /** Throws when the device is away or does not answer. */
    Conn dial(String address) throws IOException;

    /** Starts accepting; throws when the adapter is off or missing. */
    void listen(Acceptor onConn) throws IOException;

    void stop();
}
