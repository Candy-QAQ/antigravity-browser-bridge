import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLogger,
  createNativeReader,
  createPipeReader,
  ensureAuthToken,
  getPipePath,
  spawnBrokerIfNeeded,
  writeNativeMessage,
  writePipeMessage,
} from '../server/protocol.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const brokerScriptPath = path.resolve(__dirname, '../server/broker.mjs');
const log = createLogger(path.join(__dirname, 'native-host.log'));

let pipeSocket = null;
let brokerAuthed = false;
let connecting = false;
let spawnAttemptedRecently = 0;
let reconnectTimer = null;
let exiting = false;

let lastHello = null;
let lastStatusUpdate = null;
let lastTabsSync = null;

function scheduleReconnect(delayMs = 1500) {
  if (exiting || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToBroker();
  }, delayMs);
}

function sendHelloToBroker(sock) {
  if (!lastHello || sock.destroyed || !sock.writable) return;
  const token = ensureAuthToken();
  writePipeMessage(sock, {
    type: 'hello',
    role: 'browser',
    token,
    browserId: lastHello.browserId,
    browserName: lastHello.browserName,
    extensionVersion: lastHello.extensionVersion,
    paused: lastStatusUpdate?.paused ?? lastHello.paused ?? false,
    selectedTabIds: lastStatusUpdate?.selectedTabIds ?? lastHello.selectedTabIds ?? [],
    attachedTabs: lastStatusUpdate?.attachedTabs ?? lastHello.attachedTabs ?? [],
  });
}

function connectToBroker() {
  if (exiting || connecting || (pipeSocket && !pipeSocket.destroyed)) return;
  connecting = true;
  const pipePath = getPipePath();
  const sock = net.createConnection(pipePath);
  sock.setNoDelay?.(true);

  sock.on('connect', () => {
    connecting = false;
    pipeSocket = sock;
    brokerAuthed = false;
    log('info', 'Connected to broker pipe', { pipePath });
    if (lastHello) {
      sendHelloToBroker(sock);
    }
  });

  createPipeReader(
    sock,
    (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello_ack') {
        if (msg.ok) {
          brokerAuthed = true;
          log('info', 'Authenticated with broker', { browserId: msg.browserId });
          if (lastStatusUpdate) {
            writePipeMessage(sock, lastStatusUpdate);
          }
          if (lastTabsSync) {
            writePipeMessage(sock, lastTabsSync);
          }
        } else {
          log('error', 'Broker rejected hello', { error: msg.error });
          sock.destroy();
        }
        return;
      }
      if (msg.type === 'request') {
        try {
          writeNativeMessage(process.stdout, msg);
        } catch (err) {
          log('error', 'Failed writing native message to stdout', { error: err?.message });
        }
      }
    },
    (err) => {
      log('warn', 'Pipe parse error in native-host', { error: err?.message });
    }
  );

  sock.on('error', (err) => {
    connecting = false;
    const code = err?.code || '';
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      const now = Date.now();
      if (now - spawnAttemptedRecently > 3000) {
        spawnAttemptedRecently = now;
        spawnBrokerIfNeeded(brokerScriptPath, log);
        scheduleReconnect(60);
        return;
      }
      if (now - spawnAttemptedRecently <= 600) {
        scheduleReconnect(90);
        return;
      }
    } else {
      log('warn', 'Broker pipe error', { code, error: err?.message });
    }
    scheduleReconnect(1200);
  });

  sock.on('close', () => {
    connecting = false;
    if (pipeSocket === sock) {
      pipeSocket = null;
      brokerAuthed = false;
    }
    scheduleReconnect(1500);
  });
}

// Keep stdin as raw binary Buffer; never call setEncoding on process.stdin
createNativeReader(
  process.stdin,
  (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ping') {
      try {
        writeNativeMessage(process.stdout, { type: 'pong', ts: Date.now() });
      } catch (err) {
        log('error', 'Failed writing pong', { error: err?.message });
      }
      return;
    }

    if (msg.type === 'hello') {
      lastHello = msg;
      log('info', 'Received extension hello', {
        browserId: msg.browserId,
        browserName: msg.browserName,
        extensionVersion: msg.extensionVersion,
      });
      if (pipeSocket && !pipeSocket.destroyed && pipeSocket.writable) {
        sendHelloToBroker(pipeSocket);
      } else {
        connectToBroker();
      }
      return;
    }

    if (msg.type === 'status_update') {
      lastStatusUpdate = msg;
      if (pipeSocket && brokerAuthed && !pipeSocket.destroyed) {
        writePipeMessage(pipeSocket, msg);
      }
      return;
    }

    if (msg.type === 'tabs_sync') {
      lastTabsSync = msg;
      if (pipeSocket && brokerAuthed && !pipeSocket.destroyed) {
        writePipeMessage(pipeSocket, msg);
      }
      return;
    }

    if (msg.type === 'response') {
      if (pipeSocket && brokerAuthed && !pipeSocket.destroyed) {
        writePipeMessage(pipeSocket, msg);
      } else {
        log('warn', 'Dropped response because broker not ready', { reqId: msg.reqId });
      }
      return;
    }
  },
  (err) => {
    log('error', 'Native stdin framing error', { error: err?.message });
  }
);

function shutdown() {
  if (exiting) return;
  exiting = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pipeSocket && !pipeSocket.destroyed) {
    pipeSocket.destroy();
  }
  log('info', 'Native messaging host exiting cleanly');
  process.exit(0);
}

process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.stdin.on('error', shutdown);
process.stdout.on('error', shutdown);

connectToBroker();
log('info', 'Native messaging host started', { pid: process.pid });
