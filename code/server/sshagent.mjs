// The SSH side of Git hosts: an ed25519 key made here (the private half never leaves this container), its OpenSSH
// public key and fingerprint, and the agent protocol's two requests ssh needs — the identities, and a signature — so
// that ssh in the sandbox can log in with a key it never sees (bn-coded relays the agent socket's requests here).
// A signature is given only for an SSH login (a "publickey" user-authentication request for ssh-connection), for the
// key asked about, and as the caller allows (once or twice an operation; the user it names): never for arbitrary data
// (an ssh-keygen -Y signature, a git commit signature) that a process in the sandbox could ask for.
// Node built-ins only.
import crypto from 'node:crypto';

const MSG = { FAILURE: 5, SUCCESS: 6, REQUEST_IDENTITIES: 11, IDENTITIES_ANSWER: 12, SIGN_REQUEST: 13, SIGN_RESPONSE: 14 };
export const AGENT = MSG;

// SSH wire strings: uint32 length, then the bytes
export function sshString(b) {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32BE(buf.length, 0);
  return Buffer.concat([h, buf]);
}
// reader(buf) -> {u8(), u32(), str(), rest(), done()} — every read checked against the buffer's end (throws)
export function reader(buf) {
  let i = 0;
  const need = (n) => { if (n < 0 || i + n > buf.length) throw new Error('short'); };
  return {
    u8() { need(1); return buf[i++]; },
    u32() { need(4); const v = buf.readUInt32BE(i); i += 4; return v; },
    str() { const n = this.u32(); need(n); const v = buf.subarray(i, i + n); i += n; return v; },
    done() { return i === buf.length; },
  };
}

// keyBlob(pub32) -> the public key as SSH sends it: string "ssh-ed25519", string the 32 bytes
export const keyBlob = (pub) => Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
// fingerprint(blob) -> SHA256:… as ssh-keygen -l shows it
export const fingerprint = (blob) => `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
const PUB_LINE = /^ssh-ed25519 ([A-Za-z0-9+/]{68}(?:={0,2}))(?: .*)?$/;
// publicKeyBlob(line) -> the blob of an "ssh-ed25519 AAAA… comment" line, or null
export function publicKeyBlob(line) {
  const m = PUB_LINE.exec(String(line || ''));
  if (!m) return null;
  const b = Buffer.from(m[1], 'base64');
  try {
    const r = reader(b);
    if (r.str().toString() !== 'ssh-ed25519' || r.str().length !== 32 || !r.done()) return null;
  } catch { return null; }
  return b;
}
// knownHostFingerprint(line) -> {host, type, fingerprint} of a known_hosts line, or null
export function knownHostFingerprint(line) {
  const m = /^(\S+) (\S+) ([A-Za-z0-9+/]+={0,2})$/.exec(String(line || ''));
  if (!m) return null;
  return { host: m[1], type: m[2], fingerprint: fingerprint(Buffer.from(m[3], 'base64')) };
}

// newKey(comment) -> {privatePem, publicKey: "ssh-ed25519 AAAA… comment", fingerprint}: a new ed25519 key
export function newKey(comment = 'bedrock-now') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const blob = keyBlob(pub);
  const safe = String(comment).replace(/[^A-Za-z0-9._@:-]+/g, '-').slice(0, 80) || 'bedrock-now';
  return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: `ssh-ed25519 ${blob.toString('base64')} ${safe}`, fingerprint: fingerprint(blob) };
}
// loadKey(privatePem) -> {privateKey, blob} or null (an ed25519 key in PKCS#8 PEM)
export function loadKey(privatePem) {
  try {
    const privateKey = crypto.createPrivateKey(privatePem);
    if (privateKey.asymmetricKeyType !== 'ed25519') return null;
    const pub = Buffer.from(crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
    return { privateKey, blob: keyBlob(pub) };
  } catch { return null; }
}

// userauth(data) -> {user, service, method, alg, blob, hostKey} when `data` is what an SSH client signs to log in (RFC
// 4252 §7: string session id, byte 50, string user, string service, string "publickey", bool TRUE, string algorithm,
// string key blob — and, for OpenSSH's "publickey-hostbound-v00@openssh.com" (8.9 and later), string the server's host
// key — nothing after it), else null
const HOSTBOUND = 'publickey-hostbound-v00@openssh.com';
export function userauth(data) {
  try {
    const r = reader(data);
    const session = r.str();
    if (session.length < 16 || session.length > 64) return null;
    if (r.u8() !== 50) return null;
    const user = r.str().toString('utf8'), service = r.str().toString('utf8'), method = r.str().toString('utf8');
    if ((method !== 'publickey' && method !== HOSTBOUND) || service !== 'ssh-connection') return null;
    if (r.u8() !== 1) return null;
    const alg = r.str().toString('utf8'), blob = r.str();
    const hostKey = method === HOSTBOUND ? r.str() : null;
    if (!r.done()) return null;
    return { user, service, method, alg, blob, hostKey };
  } catch { return null; }
}

const one = (type, ...parts) => Buffer.concat([Buffer.from([type]), ...parts]);
export const FAILURE = one(MSG.FAILURE);
// agentAnswer(msg, keys, mayLogin) -> the answer to one agent request (without its length): the identities (keys:
// [{blob, privateKey, comment}]), a signature of an SSH login for one of them when mayLogin({user, key, hostKey})
// says yes (hostKey: the server's host key blob a host-bound login names, else null), a failure for everything else
// (other requests, other data, extensions, adding or removing keys …)
export function agentAnswer(msg, keys, mayLogin) {
  if (!Buffer.isBuffer(msg) || msg.length < 1) return FAILURE;
  if (msg[0] === MSG.REQUEST_IDENTITIES && msg.length === 1) {
    const u = Buffer.alloc(4);
    u.writeUInt32BE(keys.length, 0);
    return one(MSG.IDENTITIES_ANSWER, u, ...keys.flatMap((k) => [sshString(k.blob), sshString(k.comment || '')]));
  }
  if (msg[0] !== MSG.SIGN_REQUEST) return FAILURE;
  try {
    const r = reader(msg.subarray(1));
    const blob = r.str(), data = r.str();
    r.u32();   // flags (the RSA SHA-2 ones: nothing for ed25519)
    if (!r.done()) return FAILURE;
    const key = keys.find((k) => k.blob.equals(blob));
    const login = userauth(data);
    if (!key || !login || login.alg !== 'ssh-ed25519' || !login.blob.equals(blob)) return FAILURE;
    if (!mayLogin({ user: login.user, key, hostKey: login.hostKey })) return FAILURE;
    const sig = crypto.sign(null, data, key.privateKey);
    return one(MSG.SIGN_RESPONSE, sshString(Buffer.concat([sshString('ssh-ed25519'), sshString(sig)])));
  } catch { return FAILURE; }
}

// The well-known hosts' SSH host keys (ed25519), as each publishes them — checked against their published
// fingerprints: github.com SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU, gitlab.com
// SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8, bitbucket.org SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM
// (test/githosts.test.mjs). Any other host's key is learned once by Test connection (you see its fingerprint) or pasted.
export const KNOWN_HOSTS = {
  'github.com': ['github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'],
  'gitlab.com': ['gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf'],
  'bitbucket.org': ['bitbucket.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO'],
};
