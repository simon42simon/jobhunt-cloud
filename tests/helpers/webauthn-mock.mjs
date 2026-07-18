// SIM-394 test helper - a SOFTWARE AUTHENTICATOR for driving the full WebAuthn
// ceremonies through @simplewebauthn/server without a browser. Fabricates the
// exact wire shapes the library verifies (RegistrationResponseJSON /
// AuthenticationResponseJSON): a real P-256 keypair, real ECDSA signatures,
// real CBOR attestation ("none" fmt) - so the suites prove the verification
// path end-to-end, not a mocked-out library.
//
// The tiny CBOR encoder below covers exactly what an attestation object needs
// (unsigned/negative ints, byte strings, text strings, arrays, maps); decoding
// stays the library's own (tiny-cbor). Deliberately dependency-free.

import crypto from "node:crypto";

// ---- minimal CBOR encoder ---------------------------------------------------
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cborEncode(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, b.length), b]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const b = Buffer.from(value);
    return Buffer.concat([cborHead(2, b.length), b]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborHead(4, value.length), ...value.map(cborEncode)]);
  }
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [k, v] of value) parts.push(cborEncode(k), cborEncode(v));
    return Buffer.concat(parts);
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    const parts = [cborHead(5, keys.length)];
    for (const k of keys) parts.push(cborEncode(k), cborEncode(value[k]));
    return Buffer.concat(parts);
  }
  throw new Error(`cborEncode: unsupported value ${String(value)}`);
}

// ---- the authenticator ------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function createAuthenticator({ rpId }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    rpId,
    credId: crypto.randomBytes(32),
    privateKey,
    x: Buffer.from(jwk.x, "base64url"),
    y: Buffer.from(jwk.y, "base64url"),
  };
}

const rpIdHash = (rpId) => crypto.createHash("sha256").update(rpId).digest();

function flagsByte({ userVerified = true, attestedData = false }) {
  let f = 0x01; // UP (user present)
  if (userVerified) f |= 0x04; // UV
  if (attestedData) f |= 0x40; // AT
  return Buffer.from([f]);
}

const counterBytes = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

// COSE_Key (EC2 / ES256): {1:2, 3:-7, -1:1, -2:x, -3:y} - integer keys, so a Map.
function coseKey(auth) {
  return cborEncode(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, auth.x],
      [-3, auth.y],
    ]),
  );
}

// A registration ceremony response (fmt "none", as real platform authenticators
// answer attestationType:"none" requests). `challenge` is the base64url string
// straight out of the server's generateRegistrationOptions output.
export function attestationResponse(auth, { challenge, origin, counter = 0, transports = ["internal"], userVerified = true }) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }),
  );
  const authData = Buffer.concat([
    rpIdHash(auth.rpId),
    flagsByte({ userVerified, attestedData: true }),
    counterBytes(counter),
    Buffer.alloc(16), // aaguid (zero = "self" style, fine under fmt none)
    Buffer.from([auth.credId.length >> 8, auth.credId.length & 0xff]),
    auth.credId,
    coseKey(auth),
  ]);
  const attestationObject = cborEncode({ fmt: "none", attStmt: {}, authData });
  return {
    id: b64url(auth.credId),
    rawId: b64url(auth.credId),
    type: "public-key",
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: b64url(clientDataJSON),
      attestationObject: b64url(attestationObject),
      transports,
    },
  };
}

// An authentication (assertion) ceremony response. `counter` is what the
// authenticator claims - pass a non-advancing value to fabricate the cloned-
// authenticator signal.
export function assertionResponse(auth, { challenge, origin, counter, userVerified = true }) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }),
  );
  const authenticatorData = Buffer.concat([
    rpIdHash(auth.rpId),
    flagsByte({ userVerified }),
    counterBytes(counter),
  ]);
  const clientDataHash = crypto.createHash("sha256").update(clientDataJSON).digest();
  const signature = crypto
    .createSign("SHA256")
    .update(Buffer.concat([authenticatorData, clientDataHash]))
    .sign(auth.privateKey); // DER-encoded ECDSA, what WebAuthn carries on the wire
  return {
    id: b64url(auth.credId),
    rawId: b64url(auth.credId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authenticatorData),
      signature: b64url(signature),
      userHandle: null,
    },
  };
}
