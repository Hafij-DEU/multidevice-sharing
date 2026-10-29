package io.github.hafijbge.meshdrop;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.ParcelUuid;
import io.github.hafijbge.meshdrop.engine.bt.BtPlatform;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Bluetooth links on the phone (M14): the MeshDrop RFCOMM service through the system Bluetooth stack.
 * Pairing is Android's (Settings, Bluetooth); MeshDrop then authenticates the device itself (HELLO,
 * then mTLS over the link). Needs BLUETOOTH_CONNECT on Android 12+; without it every call fails and
 * the engine stays on Wi-Fi and the hub.
 */
final class AndroidBt implements BtPlatform {
    private static final UUID SERVICE = UUID.fromString(SERVICE_UUID);
    private final Context ctx;
    private volatile BluetoothServerSocket server;

    AndroidBt(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    private BluetoothAdapter adapter() throws IOException {
        BluetoothManager m = ctx.getSystemService(BluetoothManager.class);
        BluetoothAdapter a = m == null ? null : m.getAdapter();
        if (a == null) throw new IOException("This phone has no Bluetooth.");
        if (!a.isEnabled()) throw new IOException("Bluetooth is off.");
        return a;
    }

    @Override
    public List<Bonded> bonded() throws IOException {
        List<Bonded> out = new ArrayList<>();
        try {
            for (BluetoothDevice d : adapter().getBondedDevices()) {
                if (!candidate(d)) continue;
                String name = d.getName();
                out.add(new Bonded(d.getAddress(), name == null ? d.getAddress() : name));
            }
        } catch (SecurityException e) {
            throw new IOException("MeshDrop may not use Bluetooth.", e);
        }
        return out;
    }

    /** Phones and computers, or anything already advertising MeshDrop: never poke headphones or watches. */
    private static boolean candidate(BluetoothDevice d) {
        ParcelUuid[] uuids = d.getUuids();
        if (uuids != null) {
            for (ParcelUuid u : uuids) {
                if (SERVICE.equals(u.getUuid())) return true;
            }
        }
        BluetoothClass c = d.getBluetoothClass();
        if (c == null) return false;
        int major = c.getMajorDeviceClass();
        return major == BluetoothClass.Device.Major.PHONE || major == BluetoothClass.Device.Major.COMPUTER;
    }

    @Override
    public Conn dial(String address) throws IOException {
        BluetoothSocket s;
        try {
            BluetoothAdapter a = adapter();
            if (!BluetoothAdapter.checkBluetoothAddress(address)) throw new IOException("Not a Bluetooth address.");
            s = a.getRemoteDevice(address).createRfcommSocketToServiceRecord(SERVICE);
            // a running scan slows a connect down badly; stopping it needs BLUETOOTH_SCAN on Android 12+,
            // which MeshDrop does not ask for, so it is stopped only where that is allowed
            if (Build.VERSION.SDK_INT < 31 || ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED) {
                a.cancelDiscovery();
            }
        } catch (SecurityException e) {
            throw new IOException("MeshDrop may not use Bluetooth.", e);
        }
        try {
            s.connect();
        } catch (IOException | SecurityException e) {
            closeQuietly(s);
            throw e instanceof IOException ? (IOException) e : new IOException("MeshDrop may not use Bluetooth.", e);
        }
        return wrap(s);
    }

    @Override
    public void listen(Acceptor onConn) throws IOException {
        stop();
        BluetoothServerSocket ss;
        try {
            ss = adapter().listenUsingRfcommWithServiceRecord("MeshDrop", SERVICE);
        } catch (SecurityException e) {
            throw new IOException("MeshDrop may not use Bluetooth.", e);
        }
        server = ss;
        Thread t = new Thread(() -> {
            while (server == ss) {
                BluetoothSocket s;
                try {
                    s = ss.accept();
                } catch (IOException | SecurityException e) {
                    break; // closed by stop(), or Bluetooth went off (MeshService restarts the links)
                }
                onConn.accept(wrap(s), s.getRemoteDevice().getAddress());
            }
        }, "meshdrop-bt-accept");
        t.setDaemon(true);
        t.start();
    }

    @Override
    public void stop() {
        BluetoothServerSocket ss = server;
        server = null;
        if (ss != null) {
            try {
                ss.close();
            } catch (IOException ignored) {
                // already closed
            }
        }
    }

    private static Conn wrap(BluetoothSocket s) {
        return new Conn() {
            @Override
            public InputStream in() throws IOException {
                return s.getInputStream();
            }

            @Override
            public OutputStream out() throws IOException {
                return s.getOutputStream();
            }

            @Override
            public void close() throws IOException {
                s.close();
            }
        };
    }

    private static void closeQuietly(BluetoothSocket s) {
        try {
            s.close();
        } catch (IOException ignored) {
            // nothing to do
        }
    }
}
