/**
 * Synthetic image bytes for import tests. Only the structure the header parser reads is real;
 * none of these is a user image.
 */
export const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

/** A PNG whose IHDR claims the given size; enough for the header check, not for a decoder. */
export function pngHeader(width: number, height: number, extra: Buffer[] = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", Buffer.alloc(8)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An APNG: acTL before the first IDAT marks the animation. */
export function animatedPng() {
  return pngHeader(4, 4, [chunk("acTL", Buffer.alloc(8))]);
}

/** A baseline JPEG with one SOF0 segment. */
export function jpegHeader(width: number, height: number) {
  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), sof, Buffer.from([0xff, 0xd9])]);
}

/** A VP8X WebP; flag 0x02 marks an animation. */
export function webpHeader(width: number, height: number, flags = 0) {
  const vp8x = Buffer.alloc(18);
  vp8x.write("VP8X", 0, "ascii");
  vp8x.writeUInt32LE(10, 4);
  vp8x[8] = flags;
  vp8x.writeUIntLE(width - 1, 12, 3);
  vp8x.writeUIntLE(height - 1, 15, 3);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + vp8x.length, 4);
  riff.write("WEBP", 8, "ascii");
  return Buffer.concat([riff, vp8x]);
}

/** A body that streams `bytes` in chunks, e.g. to cross a size limit without one huge buffer. */
export function streamOf(bytes: number, first = onePixelPng.subarray(0, 16), size = 1024 * 1024) {
  let sent = 0;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const next = Math.min(size, bytes - sent);
      const value = new Uint8Array(next);
      if (sent === 0) value.set(first.subarray(0, Math.min(first.length, next)));
      sent += next;
      controller.enqueue(value);
    },
  });
  return { stream, sent: () => sent, pulls: () => pulls };
}

export function bodyOf(data: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(data));
      controller.close();
    },
  });
}

/** Resolves once `read()` satisfies `check`, polling briefly; fails after `timeout` ms. */
export async function until<T>(read: () => T, check: (value: T) => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await Bun.sleep(5);
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
