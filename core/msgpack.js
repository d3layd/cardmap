// Minimal MessagePack decoder (read-only), enough for Lightroom's catalog documents.
function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const str = (n) => {
    const s = b.toString('utf8', o, o + n);
    o += n;
    return s;
  };
  const bin = (n) => {
    const s = b.subarray(o, o + n);
    o += n;
    return s;
  };
  const arr = (n) => {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = read();
    return a;
  };
  const map = (n) => {
    const m = {};
    for (let i = 0; i < n; i++) {
      const k = read();
      m[typeof k === 'string' ? k : String(k)] = read();
    }
    return m;
  };
  function read() {
    const t = b[o++];
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 0x100;
    if (t >= 0xa0 && t <= 0xbf) return str(t & 0x1f);
    if (t >= 0x90 && t <= 0x9f) return arr(t & 0x0f);
    if (t >= 0x80 && t <= 0x8f) return map(t & 0x0f);
    let v;
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: v = b[o]; o += 1; return bin(v);
      case 0xc5: v = b.readUInt16BE(o); o += 2; return bin(v);
      case 0xc6: v = b.readUInt32BE(o); o += 4; return bin(v);
      case 0xc7: v = b[o]; o += 2; return bin(v);
      case 0xc8: v = b.readUInt16BE(o); o += 3; return bin(v);
      case 0xc9: v = b.readUInt32BE(o); o += 5; return bin(v);
      case 0xca: v = b.readFloatBE(o); o += 4; return v;
      case 0xcb: v = b.readDoubleBE(o); o += 8; return v;
      case 0xcc: v = b[o]; o += 1; return v;
      case 0xcd: v = b.readUInt16BE(o); o += 2; return v;
      case 0xce: v = b.readUInt32BE(o); o += 4; return v;
      case 0xcf: v = Number(b.readBigUInt64BE(o)); o += 8; return v;
      case 0xd0: v = b.readInt8(o); o += 1; return v;
      case 0xd1: v = b.readInt16BE(o); o += 2; return v;
      case 0xd2: v = b.readInt32BE(o); o += 4; return v;
      case 0xd3: v = Number(b.readBigInt64BE(o)); o += 8; return v;
      case 0xd4: o += 1; return bin(1);
      case 0xd5: o += 1; return bin(2);
      case 0xd6: o += 1; return bin(4);
      case 0xd7: o += 1; return bin(8);
      case 0xd8: o += 1; return bin(16);
      case 0xd9: v = b[o]; o += 1; return str(v);
      case 0xda: v = b.readUInt16BE(o); o += 2; return str(v);
      case 0xdb: v = b.readUInt32BE(o); o += 4; return str(v);
      case 0xdc: v = b.readUInt16BE(o); o += 2; return arr(v);
      case 0xdd: v = b.readUInt32BE(o); o += 4; return arr(v);
      case 0xde: v = b.readUInt16BE(o); o += 2; return map(v);
      case 0xdf: v = b.readUInt32BE(o); o += 4; return map(v);
      default: throw new Error(`Unsupported MessagePack type 0x${t.toString(16)}`);
    }
  }
  return read();
}

module.exports = { decode };
