// A minimal protobuf writer and reader: Quick Share's messages are protobuf, and only a few dozen
// fields matter here, so they are written and read by field number instead of with generated code.

const MASK64 = (1n << 64n) - 1n;

function varint(v: bigint): Buffer {
  let n = v & MASK64; // negative int32/int64 go out as their 64-bit two's complement
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n !== 0n) b |= 0x80;
    out.push(b);
  } while (n !== 0n);
  return Buffer.from(out);
}

/** Builds one message; fields come out in the order they are added. */
export class Writer {
  readonly #parts: Buffer[] = [];

  #tag(field: number, wire: number): void {
    this.#parts.push(varint(BigInt((field << 3) | wire)));
  }

  /** A varint field (int32, int64, uint, enum, bool). Skipped when undefined. */
  int(field: number, v: number | bigint | boolean | undefined): this {
    if (v === undefined) return this;
    this.#tag(field, 0);
    this.#parts.push(varint(typeof v === 'boolean' ? (v ? 1n : 0n) : BigInt(v)));
    return this;
  }

  bytes(field: number, b: Uint8Array | undefined): this {
    if (b === undefined) return this;
    this.#tag(field, 2);
    this.#parts.push(varint(BigInt(b.length)), Buffer.from(b.buffer, b.byteOffset, b.length));
    return this;
  }

  str(field: number, s: string | undefined): this {
    return s === undefined ? this : this.bytes(field, Buffer.from(s, 'utf8'));
  }

  msg(field: number, m: Writer | Buffer | undefined): this {
    return m === undefined ? this : this.bytes(field, m instanceof Writer ? m.done() : m);
  }

  done(): Buffer {
    return Buffer.concat(this.#parts);
  }
}

export class ProtoError extends Error {}

/** One parsed message: every value of every field, by field number. */
export class Fields {
  readonly #m = new Map<number, (bigint | Buffer)[]>();

  constructor(buf: Buffer) {
    let i = 0;
    const readVarint = (): bigint => {
      let r = 0n;
      for (let shift = 0n; ; shift += 7n) {
        if (i >= buf.length || shift > 63n) throw new ProtoError('bad varint');
        const b = buf[i++]!;
        r |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return r & MASK64;
      }
    };
    while (i < buf.length) {
      const key = Number(readVarint());
      const field = key >>> 3;
      const wire = key & 7;
      if (field === 0) throw new ProtoError('field 0');
      let v: bigint | Buffer;
      if (wire === 0) v = readVarint();
      else if (wire === 2) {
        const n = Number(readVarint());
        if (n > buf.length - i) throw new ProtoError('truncated field');
        v = buf.subarray(i, i + n);
        i += n;
      } else if (wire === 1 || wire === 5) {
        const n = wire === 1 ? 8 : 4;
        if (n > buf.length - i) throw new ProtoError('truncated field');
        v = buf.subarray(i, i + n);
        i += n;
      } else throw new ProtoError(`wire type ${wire}`);
      const list = this.#m.get(field);
      if (list) list.push(v);
      else this.#m.set(field, [v]);
    }
  }

  #first(field: number): bigint | Buffer | undefined {
    return this.#m.get(field)?.[0];
  }

  /** A varint field as a signed 64-bit value (undefined when absent or not a varint). */
  big(field: number): bigint | undefined {
    const v = this.#first(field);
    return typeof v === 'bigint' ? BigInt.asIntN(64, v) : undefined;
  }

  int(field: number): number | undefined {
    const v = this.big(field);
    return v === undefined ? undefined : Number(v);
  }

  bytes(field: number): Buffer | undefined {
    const v = this.#first(field);
    return Buffer.isBuffer(v) ? v : undefined;
  }

  str(field: number): string | undefined {
    return this.bytes(field)?.toString('utf8');
  }

  msg(field: number): Fields | undefined {
    const b = this.bytes(field);
    return b === undefined ? undefined : new Fields(b);
  }

  /** Every value of a repeated message field. */
  msgs(field: number): Fields[] {
    return (this.#m.get(field) ?? []).filter((v): v is Buffer => Buffer.isBuffer(v)).map((b) => new Fields(b));
  }

  /** Every value of a repeated varint field (packed or not). */
  ints(field: number): number[] {
    const out: number[] = [];
    for (const v of this.#m.get(field) ?? []) {
      if (typeof v === 'bigint') out.push(Number(BigInt.asIntN(64, v)));
      else {
        // packed: varints back to back, no tags
        let r = 0n;
        let shift = 0n;
        for (const b of v) {
          r |= BigInt(b & 0x7f) << shift;
          shift += 7n;
          if ((b & 0x80) === 0) {
            out.push(Number(BigInt.asIntN(64, r & MASK64)));
            r = 0n;
            shift = 0n;
          } else if (shift > 63n) throw new ProtoError('bad packed varint');
        }
      }
    }
    return out;
  }
}
