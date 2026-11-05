// Slot draws from the provably fair seeds. Node side (the Worker); the browser has the same in
// frontend/src/slots/slotsVerify.js and a test proves both give identical values.
//
// value(draw, counter) = first 4 bytes, big endian, of HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:slots:${draw}:${counter}`)
import crypto from 'node:crypto';

export function slotDrawMessage(clientSeed, nonce, draw, counter) {
  return `${clientSeed}:${nonce}:slots:${draw}:${counter}`;
}

export function makeUint32At(serverSeed, clientSeed, nonce) {
  return (draw, counter) => crypto.createHmac('sha256', serverSeed).update(slotDrawMessage(clientSeed, nonce, draw, counter)).digest().readUInt32BE(0);
}
