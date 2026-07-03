// capnp-es sizes its segment list from the frame header before checking it
// against the actual buffer, so hostile bytes can demand huge allocations.
// Validate the unpacked framing ourselves before parsing any capnp message.

export const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_MESSAGE_SEGMENTS = 16;

export const isSaneFramedMessage = (bytes: Uint8Array) => {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_MESSAGE_BYTES || bytes.byteLength % 4 !== 0) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segmentCount = view.getUint32(0, true) + 1;
  if (segmentCount > MAX_MESSAGE_SEGMENTS) {
    return false;
  }
  let byteOffset = 4 + segmentCount * 4;
  byteOffset += byteOffset % 8;
  if (byteOffset > bytes.byteLength) {
    return false;
  }
  for (let i = 0; i < segmentCount; i += 1) {
    byteOffset += view.getUint32(4 + i * 4, true) * 8;
    if (byteOffset > bytes.byteLength) {
      return false;
    }
  }
  return byteOffset === bytes.byteLength;
};

export const asFramedBytes = (value: unknown): Uint8Array | null => {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;
  return bytes && isSaneFramedMessage(bytes) ? bytes : null;
};
