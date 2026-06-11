const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const os = require('os');

/**
 * Phone Link server: the phone connects as role=phone, the renderer as role=viewer.
 * Binary media frames from the phone are relayed verbatim to all viewers — media never
 * crosses Electron IPC. Auth: a short-lived random code carried in the connect URL.
 */
class LinkServer {
  constructor() {
    this.wss = null;
    this.code = null;
    this.port = 8444;
    this.phone = null;
    this.viewers = new Set();
    this.onStatus = () => {};
  }

  lanIps() {
    const out = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal && !name.toLowerCase().includes('vmware')) {
          out.push(a.address);
        }
      }
    }
    return out;
  }

  start(persistDir) {
    if (this.wss) return this.info();
    // Persist the pairing code across Studio restarts — re-typing it on the phone every run
    // was real friction (field feedback).
    const fs = require('fs');
    const path = require('path');
    const codeFile = persistDir ? path.join(persistDir, 'link-code.txt') : null;
    if (codeFile && fs.existsSync(codeFile)) {
      this.code = fs.readFileSync(codeFile, 'utf8').trim();
    } else {
      this.code = crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. A1B2C3
      if (codeFile) {
        try { fs.writeFileSync(codeFile, this.code); } catch {}
      }
    }
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on('connection', (sock, req) => {
      const url = new URL(req.url, 'ws://x');
      const role = url.searchParams.get('role');
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (role === 'phone') {
        if (code !== this.code) {
          sock.close(4001, 'bad code');
          return;
        }
        this.phone?.close();
        this.phone = sock;
        this.onStatus({ phone: 'connected' });
        sock.on('message', (data, isBinary) => {
          if (!isBinary) return;
          for (const v of this.viewers) {
            if (v.readyState === 1 && v.bufferedAmount < 8 * 1024 * 1024) v.send(data);
          }
        });
        sock.on('close', () => {
          if (this.phone === sock) this.phone = null;
          this.onStatus({ phone: 'disconnected' });
        });
      } else {
        // Local viewer (the renderer).
        this.viewers.add(sock);
        sock.on('message', (data, isBinary) => {
          // Control messages from the Studio toward the phone (JSON text).
          if (!isBinary && this.phone?.readyState === 1) this.phone.send(data.toString());
        });
        sock.on('close', () => this.viewers.delete(sock));
      }
    });
    return this.info();
  }

  info() {
    return { port: this.port, code: this.code, ips: this.lanIps(), phoneConnected: !!this.phone };
  }

  stop() {
    this.wss?.close();
    this.wss = null;
    this.phone = null;
    this.viewers.clear();
  }
}

module.exports = { LinkServer };
