import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import type { AnyMessageContent } from '@whiskeysockets/baileys';
import pino from 'pino';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const PORT = process.env.PORT || process.env.PORT_WHATSAPP_GATEWAY || 3001;
const NEXTJS_WEBHOOK_URL = process.env.NEXTJS_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/web-session/webhook';
const GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET || 'gateway-secret-token-abcdef-123456';

const sessionsDir = path.resolve(__dirname, '../../../sessions');

if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

interface SessionData {
  client: any;
  qr: string | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'qr_ready';
}

const sessions = new Map<string, SessionData>();

const app = express();
app.use(cors());
app.use(express.json());

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

async function initSession(accountId: string): Promise<SessionData> {
  const existingSession = sessions.get(accountId);
  if (existingSession && existingSession.status !== 'disconnected') {
    return existingSession;
  }

  console.log(`[Gateway] Initializing Baileys session for account: ${accountId}`);

  // DYNAMIC IMPORT TO FIX RENDER TSX MODULE RESOLUTION BUGS
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.default?.default || baileys.default?.makeWASocket || baileys.makeWASocket || baileys.default || baileys;
  const { DisconnectReason, useMultiFileAuthState } = baileys.default || baileys;

  const accountSessionDir = path.join(sessionsDir, `session-${accountId}`);
  
  // Baileys multi-file auth handles keys and session state securely
  const { state, saveCreds } = await useMultiFileAuthState(accountSessionDir);

  let sock: any;
  try {
    sock = typeof makeWASocket === 'function' ? makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }) as any, // Mute baileys noisy logs
      browser: ['waCRM', 'Chrome', '1.0.0'], // Bypass bot detection naturally
    }) : (makeWASocket as any).default({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }) as any, // Mute baileys noisy logs
      browser: ['waCRM', 'Chrome', '1.0.0'], // Bypass bot detection naturally
    });
  } catch (err) {
    console.error('[Gateway] Failed to execute makeWASocket!', err);
    console.log('[Gateway] Dump of makeWASocket type:', typeof makeWASocket);
    throw err;
  }

  const sessionData: SessionData = {
    client: sock,
    qr: null,
    status: 'connecting',
  };
  sessions.set(accountId, sessionData);

  sock.ev.on('creds.update', saveCreds);

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
        console.error(`[Gateway] Error generating QR code for account ${accountId}:`, err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[Gateway] Session closed for account: ${accountId}. Reconnect? ${shouldReconnect}`);
      
      if (shouldReconnect) {
        // Automatically reconnect after a small delay
        sessionData.status = 'connecting';
        setTimeout(() => initSession(accountId), 5000);
      } else {
        sessionData.status = 'disconnected';
        sessionData.qr = null;
        sessionData.client = null;
        sessions.delete(accountId);
        
        // Wipe auth folder on explicit logout
        if (fs.existsSync(accountSessionDir)) {
          fs.rmSync(accountSessionDir, { recursive: true, force: true });
        }
        
        await notifyNextJs(accountId, { type: 'connection.status', status: 'disconnected' });
      }
    } else if (connection === 'open') {
      sessionData.status = 'connected';
      sessionData.qr = null;
      console.log(`[Gateway] Session connected for account: ${accountId}`);
      await notifyNextJs(accountId, { type: 'connection.status', status: 'connected' });
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    for (const msg of m.messages) {
      // Skip status broadcast
      if (msg.key.remoteJid === 'status@broadcast') continue;
      
      console.log(`[Gateway] Forwarding message ${msg.key.id} for account ${accountId}`);
      // Send raw Baileys message object; Next.js frontend expects this exact format!
      await notifyNextJs(accountId, {
        type: 'messages.upsert',
        message: msg,
      });
    }
  });

  return sessionData;
}

// REST ENDPOINTS

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

app.post('/api/session/connect', async (req, res) => {
  const accountId = (req.body.accountId || req.query.accountId) as string;
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return;
  }
  try {
    const session = await initSession(accountId);
    res.json({ success: true, status: session.status, qr: session.qr });
  } catch (err) {
    const error = err as Error;
    console.error(`[Gateway] Connection error for account ${accountId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/session/disconnect', async (req, res) => {
  const accountId = (req.body.accountId || req.query.accountId) as string;
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return;
  }
  const session = sessions.get(accountId);
  if (session && session.client) {
    try {
      await session.client.logout();
    } catch (err) {
      console.error(`[Gateway] Error logging out for account ${accountId}:`, err);
    }
  }
  
  // Wipe auth folder
  const accountSessionDir = path.join(sessionsDir, `session-${accountId}`);
  if (fs.existsSync(accountSessionDir)) {
    try {
      fs.rmSync(accountSessionDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[Gateway] Failed to delete session directory for account ${accountId}:`, err);
    }
  }

  sessions.delete(accountId);
  console.log(`[Gateway] Explicitly disconnected and deleted session for account: ${accountId}`);
  res.json({ success: true, status: 'disconnected' });
});

app.post('/api/messages/send', async (req, res) => {
  const { accountId, to, text } = req.body;
  if (!accountId || !to || !text) {
    res.status(400).json({ error: 'accountId, to, and text are required in body' });
    return;
  }
  const session = sessions.get(accountId);
  if (!session || session.status !== 'connected' || !session.client) {
    res.status(400).json({ error: 'WhatsApp Web session is not connected for this account' });
    return;
  }
  try {
    let targetJid = to.replace('@c.us', '@s.whatsapp.net');
    if (!targetJid.includes('@')) {
      targetJid = `${targetJid.replace(/\D/g, '')}@s.whatsapp.net`;
    }
    
    console.log(`[Gateway] Sending message to JID: ${targetJid} for account ${accountId}`);
    
    const content: AnyMessageContent = { text: text };
    const result = await session.client.sendMessage(targetJid, content);
    
    console.log(`[Gateway] Message sent successfully. Result ID:`, result?.key?.id);

    res.json({
      success: true,
      messageId: result?.key?.id,
      timestamp: result?.messageTimestamp || Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    const error = err as Error;
    console.error(`[Gateway] Error sending message for account ${accountId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

async function restoreSavedSessions() {
  try {
    const dirs = fs.readdirSync(sessionsDir).filter((file) => {
      return file.startsWith('session-') && fs.statSync(path.join(sessionsDir, file)).isDirectory();
    });
    console.log(`[Gateway] Found ${dirs.length} session folders. Restoring sessions...`);
    for (const dir of dirs) {
      const accountId = dir.replace('session-', '');
      initSession(accountId).catch((err) => {
        console.error(`[Gateway] Failed to restore session for account ${accountId}:`, err);
      });
    }
  } catch (err) {
    console.error('[Gateway] Error restoring saved sessions:', err);
  }
}

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`[Gateway] WhatsApp Baileys Engine running`);
  console.log(`          Port: ${PORT}`);
  console.log(`          Webhook URL: ${NEXTJS_WEBHOOK_URL}`);
  console.log(`=======================================================`);
  restoreSavedSessions();
});
