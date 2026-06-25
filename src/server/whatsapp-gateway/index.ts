import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import pkg from 'whatsapp-web.js';
import type { Message } from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
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
  client: InstanceType<typeof Client> | null;
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

  console.log(`[Gateway] Initializing whatsapp-web.js session for account: ${accountId}`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: accountId,
      dataPath: sessionsDir,
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ],
    },
  });

  const sessionData: SessionData = {
    client,
    qr: null,
    status: 'connecting',
  };
  sessions.set(accountId, sessionData);

  client.on('qr', async (qr) => {
    try {
      const qrDataUri = await QRCode.toDataURL(qr);
      sessionData.qr = qrDataUri;
      sessionData.status = 'qr_ready';
      console.log(`[Gateway] QR code generated for account: ${accountId}`);
      await notifyNextJs(accountId, { type: 'connection.status', status: 'qr_ready', qr: qrDataUri });
    } catch (err) {
      console.error(`[Gateway] Error generating QR code for account ${accountId}:`, err);
    }
  });

  client.on('ready', async () => {
    sessionData.status = 'connected';
    sessionData.qr = null;
    console.log(`[Gateway] Session connected for account: ${accountId}`);
    await notifyNextJs(accountId, { type: 'connection.status', status: 'connected' });
  });

  client.on('disconnected', async (reason) => {
    console.log(`[Gateway] Session disconnected for account: ${accountId}. Reason: ${reason}`);
    sessionData.status = 'disconnected';
    sessionData.qr = null;
    sessionData.client = null;
    sessions.delete(accountId);
    await notifyNextJs(accountId, { type: 'connection.status', status: 'disconnected' });
  });

  // Handle incoming / outgoing messages
  // whatsapp-web.js uses 'message_create' for both incoming and outgoing
  client.on('message_create', async (msg: Message) => {
    // Skip status broadcasts
    if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;
    
    const isFromMe = msg.fromMe;
    const remoteJid = (isFromMe ? msg.to : msg.from).replace('@c.us', '@s.whatsapp.net');
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notifyName = (msg as any)._data?.notifyName || null;
    
    const baileysMsg = {
      key: {
        remoteJid,
        fromMe: isFromMe,
        id: msg.id.id,
        participant: msg.author || undefined,
      },
      message: {
        conversation: msg.type === 'chat' ? msg.body : undefined,
        extendedTextMessage: msg.type === 'chat' ? { text: msg.body } : undefined,
      },
      messageTimestamp: msg.timestamp,
      pushName: notifyName,
    };

    console.log(`[Gateway] Forwarding message ${msg.id.id} for account ${accountId}`);
    await notifyNextJs(accountId, {
      type: 'messages.upsert',
      message: baileysMsg,
    });
  });

  try {
    client.initialize();
  } catch (err) {
    console.error(`[Gateway] Failed to initialize client for account ${accountId}:`, err);
  }

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
      await session.client.destroy();
    } catch (err) {
      console.error(`[Gateway] Error logging out for account ${accountId}:`, err);
    }
  }
  
  // Clean up directory created by LocalAuth
  const sessionPath = path.join(sessionsDir, `session-${accountId}`);
  if (fs.existsSync(sessionPath)) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
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
    let formattedJid = to.replace('@s.whatsapp.net', '@c.us');
    if (!formattedJid.includes('@')) {
      formattedJid = `${formattedJid.replace(/\D/g, '')}@c.us`;
    }
    
    console.log(`[Gateway] Resolving contact ID for ${formattedJid}...`);
    const contactId = await session.client.getNumberId(formattedJid);
    let targetJid = contactId ? contactId._serialized : formattedJid;
    
    // Workaround: Force the client to initialize the contact and chat in its internal IndexedDB to avoid "No LID for user" errors
    try {
      await session.client.getContactById(targetJid);
    } catch (e) {
      console.warn(`[Gateway] Could not pre-fetch contact for ${targetJid}:`, e);
    }
    
    try {
      await session.client.getChatById(targetJid);
    } catch (e) {
      const errMessage = e instanceof Error ? e.message : String(e);
      console.warn(`[Gateway] Could not pre-fetch chat for ${targetJid}:`, errMessage);
      if (errMessage.includes('No LID for user') && targetJid.includes('@c.us')) {
        console.log(`[Gateway] Falling back to @lid format for chat pre-fetch...`);
        targetJid = targetJid.replace('@c.us', '@lid');
      }
    }
    
    console.log(`[Gateway] Sending message to resolved JID: ${targetJid} for account ${accountId}`);
    console.log(`[Gateway] Message content:`, text);
    
    // send message
    let result;
    try {
      result = await session.client.sendMessage(targetJid, text);
    } catch (e) {
      const errMessage = e instanceof Error ? e.message : String(e);
      if (errMessage.includes('No LID for user') && targetJid.includes('@c.us')) {
        console.log(`[Gateway] sendMessage failed with No LID, retrying with @lid format...`);
        targetJid = targetJid.replace('@c.us', '@lid');
        result = await session.client.sendMessage(targetJid, text);
      } else {
        throw e;
      }
    }
    console.log(`[Gateway] Message sent successfully. Result ID:`, result.id.id);

    res.json({
      success: true,
      messageId: result.id.id,
      timestamp: result.timestamp || Math.floor(Date.now() / 1000),
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
      // whatsapp-web.js LocalAuth creates folders named "session-<clientId>"
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
  console.log(`[Gateway] WhatsApp Web Session sidecar daemon running (whatsapp-web.js)`);
  console.log(`          Port: ${PORT}`);
  console.log(`          Webhook URL: ${NEXTJS_WEBHOOK_URL}`);
  console.log(`=======================================================`);
  restoreSavedSessions();
});
