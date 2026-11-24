import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface RawSocketHandlers {
  message(data: string | Uint8Array): void;
  close(code: number): void;
}

export interface RawWebSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export function handshakeKey(headers: Record<string, string | string[] | undefined>): string | null {
  const key = headers["sec-websocket-key"];
  const version = headers["sec-websocket-version"];
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key.trim())) return null;
  if (version !== "13") return null;
  return createHash("sha1").update(key.trim() + GUID).digest("base64");
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const len = payload.byteLength;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export function acceptWebSocket(
  socket: Duplex,
  head: Uint8Array,
  accept: string,
  handlers: () => RawSocketHandlers,
  opts: { maxBytes?: number } = {},
): RawWebSocket {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buf: Buffer = Buffer.from(head);
  let parts: Buffer[] = [];
  let partsBytes = 0;
  let partsText = false;
  let closed = false;
  let on: RawSocketHandlers | null = null;
  const write = (b: Buffer) => {
    if (!socket.destroyed) socket.write(b);
  };
  const finish = (code: number) => {
    if (closed) return;
    closed = true;
    on?.close(code);
  };
  const shut = (code: number, reason = "") => {
    if (!closed) {
      const r = Buffer.from(reason.slice(0, 120), "utf8");
      const p = Buffer.alloc(2 + r.byteLength);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      write(frame(0x8, p));
      finish(code);
    }
    socket.end();
    setTimeout(() => socket.destroy(), 2000).unref?.();
  };
  const ws: RawWebSocket = {
    send(data) {
      if (closed) return;
      write(typeof data === "string" ? frame(0x1, Buffer.from(data, "utf8")) : frame(0x2, data));
    },
    close(code = 1000, reason = "") {
      shut(code, reason);
    },
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const read = () => {
    for (;;) {
      if (closed || buf.byteLength < 2) return;
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if ((b0 & 0x70) !== 0) return shut(1002, "reserved bits");
      if ((b1 & 0x80) === 0) return shut(1002, "client frames are masked");
      let len = b1 & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.byteLength < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.byteLength < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(maxBytes)) return shut(1009, "too big");
        len = Number(big);
        at = 10;
      }
      if (opcode >= 0x8 && (len > 125 || !fin)) return shut(1002, "bad control frame");
      if (len > maxBytes || partsBytes + len > maxBytes) return shut(1009, "too big");
      if (buf.byteLength < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.byteLength; i++) payload[i]! ^= mask[i & 3]!;
      buf = buf.subarray(at + 4 + len);
      if (opcode === 0x8) {
        const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1005;
        return shut(code === 1005 || code < 1000 || code >= 5000 ? 1000 : code);
      }
      if (opcode === 0x9) {
        write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (parts.length > 0) return shut(1002, "unfinished message");
        partsText = opcode === 0x1;
      } else if (opcode !== 0x0 || parts.length === 0) {
        return shut(1002, "bad frame");
      }
      parts.push(payload);
      partsBytes += payload.byteLength;
      if (!fin) continue;
      const whole = Buffer.concat(parts);
      parts = [];
      partsBytes = 0;
      if (partsText) {
        let text: string;
        try {
          text = decoder.decode(whole);
        } catch {
          return shut(1007, "not utf-8");
        }
        on?.message(text);
      } else {
        on?.message(new Uint8Array(whole));
      }
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buf = buf.byteLength === 0 ? chunk : Buffer.concat([buf, chunk]);
    read();
  });
  socket.on("close", () => finish(1006));
  socket.on("error", () => finish(1006));
  queueMicrotask(() => {
    on = handlers();
    read();
  });
  return ws;
}
