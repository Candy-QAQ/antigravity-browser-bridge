import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.antigravity.browser_bridge';
export const EXTENSION_ID = 'mnccmppmfbpfjimoacoamffodlepbjhl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PLUGIN_ROOT = path.resolve(__dirname, '..');

const MAX_NATIVE_MESSAGE_BYTES = 700 * 1024;
const NATIVE_CHUNK_BASE64_CHARS = 480 * 1024; // ~360 KB raw -> well under 1 MB JSON frame
const MAX_INCOMING_NATIVE_BYTES = 64 * 1024 * 1024;

export function getSafeUsername() {
  let raw = 'user';
  try {
    raw = os.userInfo().username || process.env.USERNAME || process.env.USER || 'user';
  } catch {
    raw = process.env.USERNAME || process.env.USER || 'user';
  }
  const safe = String(raw).replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe || 'user';
}

export function getPipePath() {
  if (process.env.BRIDGE_PIPE_NAME) {
    return process.env.BRIDGE_PIPE_NAME;
  }
  return `\\\\.\\pipe\\antigravity-browser-bridge-${getSafeUsername()}`;
}

export function getTokenFilePath() {
  return process.env.BRIDGE_TOKEN_FILE || path.join(PLUGIN_ROOT, '.bridge-token');
}

export function ensureAuthToken() {
  const tokenPath = getTokenFilePath();
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/i.test(existing)) {
      return existing;
    }
  } catch {
    // Token file does not exist yet
  }

  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(tokenPath, `${generated}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing) return existing;
    }
    fs.writeFileSync(tokenPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
    return generated;
  }
}

export function verifyToken(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function createLogger(logPath, maxBytes = 512 * 1024) {
  let writeCount = 0;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    // ignore
  }

  return function log(level, message, meta) {
    try {
      writeCount += 1;
      if (writeCount % 50 === 1) {
        try {
          const stat = fs.statSync(logPath);
          if (stat.size > maxBytes) {
            fs.writeFileSync(logPath, '', 'utf8');
          }
        } catch {
          // file may not exist yet
        }
      }
      const ts = new Date().toISOString();
      const extra = meta !== undefined ? ` ${safeStringify(meta)}` : '';
      fs.appendFileSync(logPath, `[${ts}] [${level}] ${message}${extra}\n`, 'utf8');
    } catch {
      // Never write to stdout or crash on logging errors
    }
  };
}

function safeStringify(val) {
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

export function writePipeMessage(socket, msg) {
  if (!socket || socket.destroyed || !socket.writable) {
    return false;
  }
  const line = `${JSON.stringify(msg)}\n`;
  return socket.write(line, 'utf8');
}

export function createPipeReader(socket, onMessage, onError) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line);
          onMessage(parsed);
        } catch (err) {
          onError?.(err);
        }
      }
      idx = buffer.indexOf('\n');
    }
  });
}

function writeSingleNativeFrame(stream, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  stream.write(header);
  return stream.write(payload);
}

export function writeNativeMessage(stream, msg) {
  const payloadBuf = Buffer.from(JSON.stringify(msg), 'utf8');
  if (payloadBuf.length <= MAX_NATIVE_MESSAGE_BYTES) {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payloadBuf.length, 0);
    stream.write(header);
    return stream.write(payloadBuf);
  }

  const b64 = payloadBuf.toString('base64');
  const total = Math.ceil(b64.length / NATIVE_CHUNK_BASE64_CHARS);
  const chunkId = crypto.randomUUID();
  let ok = true;
  for (let i = 0; i < total; i++) {
    const part = b64.slice(i * NATIVE_CHUNK_BASE64_CHARS, (i + 1) * NATIVE_CHUNK_BASE64_CHARS);
    ok = writeSingleNativeFrame(stream, {
      __chunked: true,
      chunkId,
      idx: i,
      total,
      encoding: 'base64',
      data: part,
    }) && ok;
  }
  return ok;
}

export function createNativeReader(stream, onMessage, onError) {
  let buf = Buffer.alloc(0);
  const chunkAssembler = new Map();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of chunkAssembler.entries()) {
      if (now - entry.createdAt > 30000) {
        chunkAssembler.delete(id);
      }
    }
  }, 10000);
  cleanupTimer.unref?.();

  function handleParsed(parsed) {
    if (parsed && parsed.__chunked === true && parsed.chunkId) {
      const { chunkId, idx, total, data } = parsed;
      if (!Number.isInteger(idx) || !Number.isInteger(total) || total <= 0 || idx < 0 || idx >= total) {
        onError?.(new Error('Invalid native chunk metadata'));
        return;
      }
      let entry = chunkAssembler.get(chunkId);
      if (!entry) {
        entry = { total, parts: new Array(total), received: 0, createdAt: Date.now() };
        chunkAssembler.set(chunkId, entry);
      }
      if (entry.parts[idx] === undefined) {
        entry.parts[idx] = data;
        entry.received += 1;
      }
      if (entry.received === entry.total) {
        chunkAssembler.delete(chunkId);
        try {
          const joined = entry.parts.join('');
          const fullBuf = parsed.encoding === 'base64'
            ? Buffer.from(joined, 'base64')
            : Buffer.from(joined, 'utf8');
          const reassembled = JSON.parse(fullBuf.toString('utf8'));
          onMessage(reassembled);
        } catch (err) {
          onError?.(err);
        }
      }
      return;
    }
    onMessage(parsed);
  }

  stream.on('data', (chunk) => {
    const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buf = buf.length === 0 ? chunkBuf : Buffer.concat([buf, chunkBuf]);

    while (buf.length >= 4) {
      const msgLen = buf.readUInt32LE(0);
      if (msgLen === 0 || msgLen > MAX_INCOMING_NATIVE_BYTES) {
        const err = new Error(`Invalid native message length: ${msgLen}`);
        buf = Buffer.alloc(0);
        onError?.(err);
        return;
      }
      if (buf.length < 4 + msgLen) {
        break;
      }
      const jsonBuf = buf.subarray(4, 4 + msgLen);
      buf = buf.subarray(4 + msgLen);
      try {
        const parsed = JSON.parse(jsonBuf.toString('utf8'));
        handleParsed(parsed);
      } catch (err) {
        onError?.(err);
      }
    }
  });

  stream.on('close', () => {
    clearInterval(cleanupTimer);
  });
}

export function spawnBrokerIfNeeded(brokerScriptPath, log) {
  try {
    ensureAuthToken();
    const child = spawn(process.execPath, [brokerScriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    log?.('info', 'Spawned detached broker process', { brokerScriptPath, pid: child.pid });
  } catch (err) {
    log?.('error', 'Failed to spawn broker process', { error: err?.message });
  }
}
