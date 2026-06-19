import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from project root
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const PORT = process.env.PORT_WHATSAPP_GATEWAY || 3001;
const NEXTJS_WEBHOOK_URL = process.env.NEXTJS_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/web-session/webhook';
const GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET || 'gateway-secret-token-abcdef-123456';

const sessionsDir = path.resolve(__dirname, '../../../sessions');
const logger = pino({ level: 'warn' });

// Ensure sessions directory exists
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

interface SessionData {
  sock: ReturnType<typeof makeWASocket> | null;
  qr: string | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'qr_ready';
  reconnectAttempts: number;
}

const sessions = new Map<string, SessionData>();

const app = express();
app.use(cors());
app.use(express.json());

// Helper to notify Next.js backend of connection updates and incoming messages
async function notifyNextJs(accountId: string, payload: Record<string, unknown>) {
  try {
    const response = await fetch(NEXTJS_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gateway-secret': GATEWAY_SECRET,
      },
      body: JSON.stringify({
        accountId,
        ...payload,
      }),
    });

    if (!response.ok) {
      console.error(`[Gateway] Webhook returned non-OK status: ${response.status} ${response.statusText} for account ${accountId}`);
    }
  } catch (err) {
    const error = err as Error;
    console.error(`[Gateway] Failed to forward event to Next.js webhook for account ${accountId}:`, error.message);
  }
}

// Initialize a Baileys WhatsApp Session for an Account
async function initSession(accountId: string): Promise<SessionData> {
  const session = sessions.get(accountId);
  if (session && session.status !== 'disconnected') {
    return session;
  }

  console.log(`[Gateway] Initializing session for account: ${accountId}`);

  // Create session storage path
  const sessionPath = path.join(sessionsDir, accountId);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  // Load auth state
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // Get latest Baileys version
  let version: [number, number, number];
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    version = [2, 3000, 1015901307]; // fallback version
  }

  // Create WASocket config
  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger.child({ level: 'silent' })),
    },
    logger: logger.child({ level: 'silent' }),
  });

  const sessionData: SessionData = {
    sock,
    qr: null,
    status: 'connecting',
    reconnectAttempts: session?.reconnectAttempts || 0,
  };
  sessions.set(accountId, sessionData);

  // Monitor connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUri = await QRCode.toDataURL(qr);
        sessionData.qr = qrDataUri;
        sessionData.status = 'qr_ready';
        console.log(`[Gateway] QR code generated for account: ${accountId}`);
        await notifyNextJs(accountId, { type: 'connection.status', status: 'qr_ready', qr: qrDataUri });
      } catch (err) {
        console.error(`[Gateway] Error generating QR code image for account ${accountId}:`, err);
      }
    }

    if (connection === 'connecting') {
      sessionData.status = 'connecting';
      console.log(`[Gateway] Session connecting for account: ${accountId}`);
      await notifyNextJs(accountId, { type: 'connection.status', status: 'connecting' });
    }

    if (connection === 'open') {
      sessionData.status = 'connected';
      sessionData.qr = null;
      sessionData.reconnectAttempts = 0;
      console.log(`[Gateway] Session connected for account: ${accountId}`);
      await notifyNextJs(accountId, { type: 'connection.status', status: 'connected' });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[Gateway] Session closed for account: ${accountId}. Reason: ${statusCode}. Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        sessionData.status = 'connecting';
        sessionData.reconnectAttempts += 1;
        const delay = Math.min(3000 * Math.pow(2, sessionData.reconnectAttempts), 60000);
        console.log(`[Gateway] Scheduling reconnect in ${delay}ms for account: ${accountId}`);
        
        setTimeout(() => {
          recreateSession(accountId);
        }, delay);
      } else {
        sessionData.status = 'disconnected';
        sessionData.qr = null;
        sessionData.sock = null;
        sessions.delete(accountId);
        
        // Clean up session directory
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          console.log(`[Gateway] Cleared session credentials for account: ${accountId}`);
        } catch (err) {
          console.error(`[Gateway] Failed to delete session directory for account ${accountId}:`, err);
        }

        await notifyNextJs(accountId, { type: 'connection.status', status: 'disconnected' });
      }
    }
  });

  // Handle credentials saving
  sock.ev.on('creds.update', saveCreds);

  // Handle incoming / outgoing messages
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      // Don't forward status messages or messages without content if unnecessary
      if (!msg.message) continue;
      
      console.log(`[Gateway] Forwarding message ${msg.key.id} for account ${accountId}`);
      await notifyNextJs(accountId, {
        type: 'messages.upsert',
        message: msg as unknown as Record<string, unknown>,
      });
    }
  });

  return sessionData;
}

// Recreate session after failure/disconnect
async function recreateSession(accountId: string) {
  const session = sessions.get(accountId);
  if (session?.sock) {
    try {
      session.sock.end(undefined);
    } catch {}
  }
  await initSession(accountId);
}

// REST ENDPOINTS

// 1. Get Session Status
app.get('/api/session/status', (req, res) => {
  const accountId = (req.query.accountId || req.body.accountId) as string;
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return;
  }

  const session = sessions.get(accountId);
  if (!session) {
    res.json({ status: 'disconnected', qr: null });
    return;
  }

  res.json({
    status: session.status,
    qr: session.qr,
  });
});

// 2. Trigger Connection / Scan QR
app.post('/api/session/connect', async (req, res) => {
  const accountId = (req.body.accountId || req.query.accountId) as string;
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return;
  }

  try {
    const session = await initSession(accountId);
    res.json({
      success: true,
      status: session.status,
      qr: session.qr,
    });
  } catch (err) {
    const error = err as Error;
    console.error(`[Gateway] Connection error for account ${accountId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Disconnect / Log out session
app.post('/api/session/disconnect', async (req, res) => {
  const accountId = (req.body.accountId || req.query.accountId) as string;
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return;
  }

  const session = sessions.get(accountId);
  if (session) {
    try {
      if (session.sock) {
        await session.sock.logout();
        session.sock.end(undefined);
      }
    } catch (err) {
      console.error(`[Gateway] Error logging out Baileys socket for account ${accountId}:`, err);
    }
  }

  // Delete credentials path
  const sessionPath = path.join(sessionsDir, accountId);
  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[Gateway] Failed to delete session directory for account ${accountId}:`, err);
  }

  sessions.delete(accountId);
  console.log(`[Gateway] Explicitly disconnected and deleted session for account: ${accountId}`);

  res.json({ success: true, status: 'disconnected' });
});

// 4. Send Message via Baileys
app.post('/api/messages/send', async (req, res) => {
  const { accountId, to, text } = req.body;
  if (!accountId || !to || !text) {
    res.status(400).json({ error: 'accountId, to, and text are required in body' });
    return;
  }

  const session = sessions.get(accountId);
  if (!session || session.status !== 'connected' || !session.sock) {
    res.status(400).json({ error: 'WhatsApp Web session is not connected for this account' });
    return;
  }

  try {
    // Format JID: e.g. 1234567890@s.whatsapp.net
    const formattedJid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
    const result = await session.sock.sendMessage(formattedJid, { text });
    
    res.json({
      success: true,
      messageId: result?.key.id || null,
      timestamp: result?.messageTimestamp || Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    const error = err as Error;
    console.error(`[Gateway] Error sending message via Baileys for account ${accountId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Auto-restore saved sessions from directory on boot
async function restoreSavedSessions() {
  try {
    const dirs = fs.readdirSync(sessionsDir).filter((file) => {
      return fs.statSync(path.join(sessionsDir, file)).isDirectory();
    });

    console.log(`[Gateway] Found ${dirs.length} session folders. Restoring sessions...`);
    for (const accountId of dirs) {
      initSession(accountId).catch((err) => {
        console.error(`[Gateway] Failed to restore session for account ${accountId}:`, err);
      });
    }
  } catch (err) {
    console.error('[Gateway] Error restoring saved sessions:', err);
  }
}

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`[Gateway] WhatsApp Web Session sidecar daemon running`);
  console.log(`          Port: ${PORT}`);
  console.log(`          Webhook URL: ${NEXTJS_WEBHOOK_URL}`);
  console.log(`=======================================================`);
  restoreSavedSessions();
});
