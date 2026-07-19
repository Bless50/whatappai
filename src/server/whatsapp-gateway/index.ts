/* eslint-disable react-hooks/rules-of-hooks, @typescript-eslint/no-explicit-any */
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestWaWebVersion, type AnyMessageContent, USyncQuery, USyncUser, downloadContentFromMessage } from '@whiskeysockets/baileys';
import pino from 'pino';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ============ GLOBAL PROCESS ERROR HANDLING ============
// Prevent unhandled promise rejections or socket exceptions (like DNS ENOTFOUND
// or handshake timeouts in Baileys internals) from crashing the gateway process.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Gateway] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Gateway] Uncaught Exception thrown:', err);
});

const PORT = process.env.PORT || process.env.PORT_WHATSAPP_GATEWAY || 3001;
const NEXTJS_WEBHOOK_URL = process.env.NEXTJS_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/web-session/webhook';
const GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET || 'gateway-secret-token-abcdef-123456';

const sessionsDir = path.resolve(process.cwd(), 'sessions');

if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

interface SessionData {
  client: any;
  qr: string | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'qr_ready';
  retryCount?: number;
  reconnectTimeout?: NodeJS.Timeout | null;
}

interface ConnectionUpdate {
  connection?: string;
  lastDisconnect?: {
    error?: Error;
  };
  qr?: string;
}

interface MessagesUpsert {
  messages: any[];
  type: string;
}

const sessions = new Map<string, SessionData>();

// ============ LID CONTACT TRACKING ============
// WhatsApp now uses LID (Linked Identity) JIDs. Per Baileys docs, the CORRECT
// way to reply to a @lid contact is to send to `number@lid` directly —
// Baileys resolves it internally. Do NOT convert @lid to @s.whatsapp.net.
//
// lidToPhoneJid: LID number → phone@s.whatsapp.net (populated when available)
// knownLidNumbers: tracks which numbers were seen as @lid JIDs (used as send fallback)
const lidToPhoneJid = new Map<string, string>();
const knownLidNumbers = new Set<string>(); // numbers that are LID-based, not real phone numbers

// ============ BAILEYS DECODE & MEDIA HELPERS ============
function unwrapBaileysMessage(m: any): any {
  if (!m) return m;
  if (m.ephemeralMessage?.message) return unwrapBaileysMessage(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return unwrapBaileysMessage(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return unwrapBaileysMessage(m.viewOnceMessageV2.message);
  if (m.documentWithCaptionMessage?.message) return unwrapBaileysMessage(m.documentWithCaptionMessage.message);
  if (m.deviceSentMessage?.message) return unwrapBaileysMessage(m.deviceSentMessage.message);
  if (m.editedMessage?.message) return unwrapBaileysMessage(m.editedMessage.message);
  if (m.protocolMessage?.editedMessage) return unwrapBaileysMessage(m.protocolMessage.editedMessage);
  return m;
}

function getMimeType(type: string, _ext: string): string {
  if (type === 'image') return 'image/jpeg';
  if (type === 'audio') return 'audio/ogg';
  if (type === 'video') return 'video/mp4';
  return 'application/octet-stream';
}

async function downloadAndUploadMedia(accountId: string, msg: any): Promise<{ publicUrl: string; mimeType: string } | null> {
  const unwrapped = unwrapBaileysMessage(msg.message);
  if (!unwrapped) return null;

  let mediaMessage: any = null;
  let mediaType: 'image' | 'video' | 'audio' | 'document' | null = null;
  let filename = 'file';
  let extension = 'bin';

  if (unwrapped.imageMessage) {
    mediaMessage = unwrapped.imageMessage;
    mediaType = 'image';
    extension = 'jpg';
  } else if (unwrapped.audioMessage) {
    mediaMessage = unwrapped.audioMessage;
    mediaType = 'audio';
    extension = 'ogg';
  } else if (unwrapped.videoMessage) {
    mediaMessage = unwrapped.videoMessage;
    mediaType = 'video';
    extension = 'mp4';
  } else if (unwrapped.documentMessage) {
    mediaMessage = unwrapped.documentMessage;
    mediaType = 'document';
    filename = unwrapped.documentMessage.fileName || 'document';
    const parts = filename.split('.');
    extension = parts.length > 1 ? parts.pop()!.toLowerCase() : 'bin';
  }

  if (!mediaMessage || !mediaType) return null;

  try {
    console.log(`[Gateway] Downloading media content of type ${mediaType} for message ${msg.key.id}`);
    const stream = await downloadContentFromMessage(mediaMessage, mediaType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }

    const rawMimeType = mediaMessage.mimetype || getMimeType(mediaType, extension);
    const mimeType = rawMimeType.split(';')[0].trim();
    
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      console.warn(`[Gateway] Supabase URL or Service Key not configured. Skipping media upload.`);
      return null;
    }

    const safeBase = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'file';
    const now = Date.now();
    const storagePath = `account-${accountId}/${now}-${safeBase}.${extension}`;
    const uploadUrl = `${supabaseUrl}/storage/v1/object/chat-media/${storagePath}`;

    console.log(`[Gateway] Uploading downloaded media to Supabase: ${uploadUrl}`);
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Content-Type': mimeType,
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error(`[Gateway] Supabase upload failed with status ${uploadRes.status}: ${errText}`);
      return null;
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/chat-media/${storagePath}`;
    console.log(`[Gateway] Uploaded successfully. Public URL: ${publicUrl}`);
    return { publicUrl, mimeType };
  } catch (err) {
    console.error(`[Gateway] Error downloading/uploading media:`, err);
    return null;
  }
}

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
  if (existingSession && existingSession.client) {
    return existingSession;
  }

  // Clear any existing reconnect timer to prevent overlapping attempts
  if (existingSession?.reconnectTimeout) {
    clearTimeout(existingSession.reconnectTimeout);
    existingSession.reconnectTimeout = null;
  }

  console.log(`[Gateway] Initializing Baileys session for account: ${accountId}`);


  const accountSessionDir = path.join(sessionsDir, `session-${accountId}`);
  
  // Baileys multi-file auth handles keys and session state securely
  const { state, saveCreds } = await useMultiFileAuthState(accountSessionDir);

  // Always use the latest WhatsApp Web version from the API.
  // Using a hardcoded/invented version number that doesn't match what WhatsApp
  // expects causes server-side protocol mismatches and delivery ERRORs.
  let version: [number, number, number] = [2, 3000, 1015901307]; // Safe known-good fallback
  try {
    const { version: latestVersion } = await fetchLatestWaWebVersion({});
    if (latestVersion) {
      version = latestVersion;
      console.log(`[Gateway] Using WhatsApp Web version: ${version.join('.')}`);
    } else {
      console.warn(`[Gateway] fetchLatestWaWebVersion returned empty, using fallback: ${version.join('.')}`);
    }
  } catch {
    console.warn(`[Gateway] Failed to fetch latest WhatsApp Web version, using fallback: ${version.join('.')}`);
  }

  let sock: any;
  try {
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'info' }) as any, // Mute baileys noisy logs
      browser: ['waCRM', 'Chrome', '1.0.0'], // Bypass bot detection naturally
    });
  } catch (err) {
    console.error('[Gateway] Failed to execute makeWASocket!', err);
    throw err;
  }

  const sessionData: SessionData = {
    client: sock,
    qr: null,
    status: 'connecting',
  };
  sessions.set(accountId, sessionData);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update: ConnectionUpdate) => {
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
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

      // ============ CLASSIFY DISCONNECT REASON ============
      // Only an explicit logout (401) is immediately fatal and should
      // wipe credentials. Other codes (405 = handshake rejected,
      // 500 = badSession, 408 = timeout) are often transient —
      // especially after a network hiccup. Let the exponential-backoff
      // retry loop handle them. If retries are exhausted, credentials
      // are wiped then (see maxRetries block below).
      const isExplicitLogout = statusCode === DisconnectReason.loggedOut; // 401
      const shouldReconnect = !isExplicitLogout;

      if (isExplicitLogout) {
        console.warn(`[Gateway] Explicit logout for account ${accountId} (status code: ${statusCode}). Wiping session credentials.`);
      } else {
        console.log(`[Gateway] Session closed for account: ${accountId} (status code: ${statusCode}). Will retry. Error:`, lastDisconnect?.error?.message || lastDisconnect?.error);
      }
      
      // Clean up connection references and prevent overlapping reconnection attempts
      // by ending the current socket cleanly and removing its listeners.
      try {
        if (sock) {
          sock.ev.removeAllListeners();
          sock.end(undefined);
        }
      } catch {
        // Ignored
      }
      sessionData.client = null;
      sessionData.qr = null;
      
      if (shouldReconnect) {
        sessionData.retryCount = (sessionData.retryCount || 0) + 1;
        const maxRetries = 5;
        
        if (sessionData.retryCount > maxRetries) {
          console.warn(`[Gateway] Max reconnect attempts (${maxRetries}) reached for account ${accountId}. Stopping automatic reconnection.`);
          sessionData.status = 'disconnected';
          sessionData.qr = null;
          sessionData.client = null;
          if (sessionData.reconnectTimeout) {
            clearTimeout(sessionData.reconnectTimeout);
            sessionData.reconnectTimeout = null;
          }
          sessions.delete(accountId);

          // Wipe credentials only after exhausting all retries —
          // if the session is truly broken the user needs to re-pair.
          if (statusCode === 405 || statusCode === 500) {
            console.warn(`[Gateway] Wiping stale session credentials for account ${accountId} after ${maxRetries} failed retries (status ${statusCode}).`);
            if (fs.existsSync(accountSessionDir)) {
              fs.rmSync(accountSessionDir, { recursive: true, force: true });
            }
          }

          await notifyNextJs(accountId, { type: 'connection.status', status: 'disconnected' });
        } else {
          sessionData.status = 'connecting';
          const delay = Math.min(2000 * Math.pow(2, sessionData.retryCount), 60000);
          console.log(`[Gateway] Scheduling reconnect attempt ${sessionData.retryCount}/${maxRetries} in ${delay}ms for account: ${accountId}`);
          
          if (sessionData.reconnectTimeout) {
            clearTimeout(sessionData.reconnectTimeout);
          }
          sessionData.reconnectTimeout = setTimeout(() => {
            if (sessions.has(accountId)) {
              initSession(accountId).catch((err) => {
                console.error(`[Gateway] Error during scheduled reconnect for account ${accountId}:`, err);
              });
            }
          }, delay);
        }
      } else {
        sessionData.status = 'disconnected';
        sessionData.qr = null;
        sessionData.client = null;
        if (sessionData.reconnectTimeout) {
          clearTimeout(sessionData.reconnectTimeout);
          sessionData.reconnectTimeout = null;
        }
        sessions.delete(accountId);
        
        // Wipe auth folder on explicit logout only
        if (fs.existsSync(accountSessionDir)) {
          fs.rmSync(accountSessionDir, { recursive: true, force: true });
        }
        
        await notifyNextJs(accountId, { type: 'connection.status', status: 'disconnected' });
      }
    } else if (connection === 'open') {
      sessionData.status = 'connected';
      sessionData.qr = null;
      sessionData.retryCount = 0; // Reset retry count on success
      if (sessionData.reconnectTimeout) {
        clearTimeout(sessionData.reconnectTimeout);
        sessionData.reconnectTimeout = null;
      }
      console.log(`[Gateway] Session connected for account: ${accountId}`);
      await notifyNextJs(accountId, { type: 'connection.status', status: 'connected' });
    }
  });

  // ============ LID → PHONE NUMBER MAPPING ============
  // WhatsApp uses LID (Linked Identity) JIDs for privacy. Messages arrive
  // as `12345@lid` but replies MUST be sent to `phone@s.whatsapp.net`.
  // Three resolution strategies (in priority order):
  //   1. key.senderPn from incoming messages (most reliable)
  //   2. lid-mapping.update event from Baileys sync
  //   3. sock.signalRepository.lidMapping.getPNForLID() at send time

  // Strategy 2: Listen for Baileys LID mapping sync events
  sock.ev.on('lid-mapping.update' as any, (mapping: any) => {
    if (mapping?.lid && mapping?.pn) {
      const lidNumber = String(mapping.lid).split('@')[0];
      const phoneJid = String(mapping.pn).includes('@')
        ? String(mapping.pn)
        : `${String(mapping.pn)}@s.whatsapp.net`;
      lidToPhoneJid.set(lidNumber, phoneJid);
      console.log(`[Gateway] LID mapping synced: ${lidNumber} → ${phoneJid}`);
    }
  });

  // Keep existing listeners as backup (they sometimes fire in newer versions)
  sock.ev.on('chats.phoneNumberShare', (data: { lid: string; jid: string }) => {
    const lidNumber = data.lid.split('@')[0];
    if (lidNumber && data.jid) {
      lidToPhoneJid.set(lidNumber, data.jid);
      console.log(`[Gateway] LID mapping (phoneNumberShare): ${data.lid} → ${data.jid}`);
    }
  });

  sock.ev.on('contacts.upsert', (contacts: any[]) => {
    for (const contact of contacts) {
      if (contact.lid && contact.id) {
        const lidNumber = contact.lid.split('@')[0];
        const phoneJid = contact.id.endsWith('@s.whatsapp.net')
          ? contact.id
          : `${contact.id}@s.whatsapp.net`;
        lidToPhoneJid.set(lidNumber, phoneJid);
        knownLidNumbers.add(lidNumber);
        console.log(`[Gateway] LID mapping (contacts.upsert): ${contact.lid} → ${phoneJid}`);
      }
    }
  });

  // Capture historical messages and LID mappings from the initial full history sync that fires on connect
  sock.ev.on('messaging-history.set' as any, async (payload: { chats?: any[], contacts?: any[], messages?: any[], isLatest?: boolean }) => {
    const { contacts, messages } = payload;
    
    // 1. Process contacts for LID mapping
    if (contacts?.length) {
      let mapped = 0;
      for (const contact of contacts) {
        if (contact.lid && contact.id) {
          const lidNumber = contact.lid.split('@')[0];
          const phoneJid = contact.id.endsWith('@s.whatsapp.net')
            ? contact.id
            : `${contact.id}@s.whatsapp.net`;
          lidToPhoneJid.set(lidNumber, phoneJid);
          knownLidNumbers.add(lidNumber);
          mapped++;
        }
      }
      if (mapped > 0) console.log(`[Gateway] LID mappings from history-sync: ${mapped} contacts mapped`);
    }

    // 2. Process historical messages (limit to last 30 days)
    if (messages?.length) {
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
      
      const recentHistoricalMessages = messages.filter(msg => {
        // Skip status broadcast
        if (msg.key?.remoteJid === 'status@broadcast') return false;
        
        // Skip group messages (we only want DMs per requirement)
        if (msg.key?.remoteJid?.endsWith('@g.us')) return false;

        const ts = typeof msg.messageTimestamp === 'number' 
          ? msg.messageTimestamp 
          : parseInt(msg.messageTimestamp as string, 10);
        
        return ts >= thirtyDaysAgo;
      });

      if (recentHistoricalMessages.length > 0) {
        console.log(`[Gateway] Forwarding ${recentHistoricalMessages.length} historical messages (out of ${messages.length} total) from history-sync to webhook.`);
        await notifyNextJs(accountId, { 
          type: 'messaging-history.set', 
          messages: recentHistoricalMessages 
        });
      }
    }
  });

  // Capture LID updates that arrive after the initial sync
  sock.ev.on('contacts.update', (updates: any[]) => {
    for (const update of updates) {
      if (update.lid && update.id) {
        const lidNumber = update.lid.split('@')[0];
        const phoneJid = update.id.endsWith('@s.whatsapp.net')
          ? update.id
          : `${update.id}@s.whatsapp.net`;
        lidToPhoneJid.set(lidNumber, phoneJid);
        knownLidNumbers.add(lidNumber);
        console.log(`[Gateway] LID mapping (contacts.update): ${update.lid} → ${phoneJid}`);
      }
    }
  });

  sock.ev.on('messages.upsert', async (m: MessagesUpsert) => {
    console.log(`[Gateway] messages.upsert triggered: ${m.messages?.length || 0} messages. Type: ${m.type}`);
    for (const msg of m.messages) {
      // Skip status broadcast
      if (msg.key.remoteJid === 'status@broadcast') continue;

      // Strategy 1: Extract senderPn from incoming messages
      // When remoteJid is @lid, senderPn contains the real phone number
      const senderPn = (msg.key as any).senderPn;
      if (!msg.key.fromMe && msg.key.remoteJid?.endsWith('@lid')) {
        const lidNumber = msg.key.remoteJid.split('@')[0];
        // Always record this as a known LID number so the send endpoint
        // can fall back to @lid instead of @s.whatsapp.net
        knownLidNumbers.add(lidNumber);
        if (senderPn) {
          const phoneJid = senderPn.includes('@')
            ? senderPn
            : `${senderPn}@s.whatsapp.net`;
          lidToPhoneJid.set(lidNumber, phoneJid);
          console.log(`[Gateway] LID mapping (senderPn): ${lidNumber} → ${phoneJid}`);
        }
      }

      // If remoteJid is @lid, look up the resolved phone JID to pass alongside the message
      let resolvedPhoneJid: string | null = null;
      if (!msg.key.fromMe && msg.key.remoteJid?.endsWith('@lid')) {
        const lidNumber = msg.key.remoteJid.split('@')[0];
        resolvedPhoneJid = lidToPhoneJid.get(lidNumber) || null;

        // Strategy 3: try signalRepository at forward-time if event-based map missed it
        if (!resolvedPhoneJid && sessionData?.client) {
          try {
            const repo = (sessionData.client as any).signalRepository;
            if (repo?.lidMapping?.getPNForLID) {
              const pn = await repo.lidMapping.getPNForLID(`${lidNumber}@lid`);
              if (pn) {
                resolvedPhoneJid = String(pn).includes('@') ? String(pn) : `${pn}@s.whatsapp.net`;
                lidToPhoneJid.set(lidNumber, resolvedPhoneJid);
                console.log(`[Gateway] LID resolved at forward-time via signalRepository: ${lidNumber} → ${resolvedPhoneJid}`);
              }
            }
          } catch {
            // Ignored
          }
        }

        // Strategy 4: USync query — most reliable when all other methods fail.
        // We fire this synchronously so the resolvedPhoneJid is available for
        // this webhook call, and also cached for future sends.
        if (!resolvedPhoneJid && sessionData?.client) {
          try {
            const usyncQuery = new USyncQuery().withContext('message').withContactProtocol();
            usyncQuery.withUser(new USyncUser().withId(`${lidNumber}@lid`));
            const result = await sessionData.client.executeUSyncQuery(usyncQuery);
            // USync returns an array of user results; each may have a `pn` (phone number) field
            const users: any[] = result?.list ?? result?.users ?? [];
            for (const u of users) {
              const pn = u.contact?.pn ?? u.pn ?? u.phone;
              if (pn) {
                resolvedPhoneJid = String(pn).includes('@') ? String(pn) : `${pn}@s.whatsapp.net`;
                lidToPhoneJid.set(lidNumber, resolvedPhoneJid);
                console.log(`[Gateway] LID resolved via USync: ${lidNumber} → ${resolvedPhoneJid}`);
                break;
              }
            }
          } catch (usyncErr) {
            console.warn(`[Gateway] USync resolution failed for LID ${lidNumber}:`, (usyncErr as Error).message);
          }
        }

        if (!resolvedPhoneJid) {
          console.warn(`[Gateway] Could not resolve phone for LID ${lidNumber} — forwarding without resolvedPhoneJid`);
        }
      }

      const mediaPayload: { mediaUrl?: string; mediaType?: string } = {};
      const unwrapped = unwrapBaileysMessage(msg.message);
      if (unwrapped && (unwrapped.imageMessage || unwrapped.audioMessage || unwrapped.videoMessage || unwrapped.documentMessage)) {
        const mediaResult = await downloadAndUploadMedia(accountId, msg);
        if (mediaResult) {
          mediaPayload.mediaUrl = mediaResult.publicUrl;
          mediaPayload.mediaType = mediaResult.mimeType;
        }
      }

      console.log(`[Gateway] Forwarding message ${msg.key.id} for account ${accountId} (remoteJid: ${msg.key.remoteJid}, fromMe: ${msg.key.fromMe}, senderPn: ${senderPn || 'none'})${resolvedPhoneJid ? `, resolvedPhone: ${resolvedPhoneJid}` : ''}`);
      // Send raw Baileys message object; Next.js frontend expects this exact format!
      // resolvedPhoneJid is set for @lid senders so the webhook can find the real phone number.
      await notifyNextJs(accountId, {
        type: 'messages.upsert',
        message: msg,
        ...(resolvedPhoneJid ? { resolvedPhoneJid } : {}),
        ...mediaPayload,
      });
    }
  });

  // ============ DELIVERY STATUS TRACKING ============
  // Baileys fires messages.update when the server reports status changes:
  //   status 2 = SERVER_ACK (server received)
  //   status 3 = DELIVERY_ACK (delivered to recipient device)
  //   status 4 = READ (recipient read it)
  //   status 5 = PLAYED (for audio/video)
  //   status: 'error' = delivery failed
  sock.ev.on('messages.update', (updates: any[]) => {
    for (const update of updates) {
      const { key, update: statusUpdate } = update;
      if (key?.remoteJid === 'status@broadcast') continue;

      if (statusUpdate?.status !== undefined) {
        const statusNames: Record<number, string> = {
          0: 'ERROR',
          1: 'PENDING',
          2: 'SERVER_ACK',
          3: 'DELIVERY_ACK',
          4: 'READ',
          5: 'PLAYED',
        };
        const statusName = statusNames[statusUpdate.status] || `UNKNOWN(${statusUpdate.status})`;
        if (statusUpdate.status === 0) {
          // Log full update detail on ERROR to help diagnose delivery failures
          console.error(`[Gateway] Message ${key.id} status → ERROR (to: ${key.remoteJid}, account: ${accountId}) full:`, JSON.stringify(statusUpdate));
        } else {
          console.log(`[Gateway] Message ${key.id} status → ${statusName} (to: ${key.remoteJid}, account: ${accountId})`);
        }
      }
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

app.get('/api/session/resolve-lid', async (req, res) => {
  const accountId = req.query.accountId as string;
  const lid = req.query.lid as string;
  
  if (!accountId || !lid) {
    res.status(400).json({ error: 'accountId and lid are required' });
    return;
  }
  
  const session = sessions.get(accountId);
  if (!session || !session.client) {
    res.status(400).json({ error: 'WhatsApp session is not active' });
    return;
  }
  
  try {
    const cleanLid = lid.includes('@') ? lid : `${lid}@lid`;
    console.log(`[Gateway] Resolving LID ${cleanLid} for account ${accountId} via USync...`);
    
    const usyncQuery = new USyncQuery()
      .withContext('message')
      .withContactProtocol();
      
    usyncQuery.withUser(new USyncUser().withId(cleanLid));
    
    const result = await session.client.executeUSyncQuery(usyncQuery);
    console.log(`[Gateway] USync raw result for ${cleanLid}:`, JSON.stringify(result, null, 2));
    
    res.json({ success: true, result });
  } catch (err: any) {
    console.error(`[Gateway] USync query failed:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/session/connect', async (req, res) => {
  const accountId = (req.body.accountId || req.query.accountId) as string;
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return;
  }
  
  // Reset retry state on explicit connection request
  const existingSession = sessions.get(accountId);
  if (existingSession) {
    existingSession.retryCount = 0;
    if (existingSession.reconnectTimeout) {
      clearTimeout(existingSession.reconnectTimeout);
      existingSession.reconnectTimeout = null;
    }
    // EXPLICITLY close any old client connection to prevent conflicts
    if (existingSession.client) {
      try {
        console.log(`[Gateway] Connection request received: ending existing socket for account ${accountId} to avoid conflicts.`);
        existingSession.client.ev.removeAllListeners();
        existingSession.client.end(undefined);
      } catch {
        // Ignored
      }
      existingSession.client = null;
    }
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
  if (session) {
    if (session.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
      session.reconnectTimeout = null;
    }
    if (session.client) {
      try {
        await session.client.logout();
      } catch (err) {
        console.error(`[Gateway] Error logging out for account ${accountId}:`, err);
      }
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

app.post('/api/messages/presence', async (req, res) => {
  const { accountId, to, presence } = req.body;
  if (!accountId || !to || !presence) {
    res.status(400).json({ error: 'accountId, to, and presence are required in body' });
    return;
  }
  const session = sessions.get(accountId);
  if (!session || session.status !== 'connected' || !session.client) {
    res.status(400).json({ error: 'WhatsApp Web session is not connected for this account' });
    return;
  }
  if (presence !== 'composing' && presence !== 'recording' && presence !== 'paused') {
    res.status(400).json({ error: 'presence must be composing, recording, or paused' });
    return;
  }
  try {
    const cleanNumber = to.replace(/\D/g, '').replace(/@.*$/, '');
    let targetJid: string;
    const resolvedPhoneJid = lidToPhoneJid.get(cleanNumber);

    if (to.includes('@')) {
      targetJid = to.replace('@c.us', '@s.whatsapp.net');
    } else if (resolvedPhoneJid) {
      targetJid = resolvedPhoneJid.includes('@') ? resolvedPhoneJid : `${resolvedPhoneJid}@s.whatsapp.net`;
    } else if (knownLidNumbers.has(cleanNumber)) {
      targetJid = `${cleanNumber}@lid`;
    } else {
      targetJid = `${cleanNumber}@s.whatsapp.net`;
    }

    await session.client.sendPresenceUpdate(presence, targetJid);
    console.log(`[Gateway] Presence updated to "${presence}" for JID: ${targetJid}`);
    res.json({ success: true });
  } catch (err) {
    const error = err as Error;
    console.error(`[Gateway] Error updating presence for account ${accountId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/messages/send', async (req, res) => {
  const { accountId, to, text, messageId, mediaUrl, mediaType, filename } = req.body;
  if (!accountId || !to || (!text && !mediaUrl)) {
    res.status(400).json({ error: 'accountId, to, and either text or mediaUrl are required in body' });
    return;
  }
  const session = sessions.get(accountId);
  if (!session || session.status !== 'connected' || !session.client) {
    res.status(400).json({ error: 'WhatsApp Web session is not connected for this account' });
    return;
  }
  try {
    const cleanNumber = to.replace(/\D/g, '').replace(/@.*$/, '');
    
    // ============ RESOLVE SEND TARGET JID ============
    // Per Baileys docs: when a contact's remoteJid was @lid, the correct
    // way to reply is to send to `number@lid` directly — Baileys handles
    // the internal resolution. Do NOT convert @lid → @s.whatsapp.net.
    //
    // Resolution order:
    //   1. `to` already contains @ (e.g. passed as full JID) — use as-is
    //   2. lidToPhoneJid map has a resolved phone → use phone@s.whatsapp.net
    //   3. signalRepository.getPNForLID() runtime lookup
    //   4. Number is a known LID → send to number@lid (Baileys native LID support)
    //   5. Unknown number → assume regular phone, use number@s.whatsapp.net
    let targetJid: string;
    let resolvedPhoneJid = lidToPhoneJid.get(cleanNumber);
 
    // Strategy 2b: Try Baileys' runtime LID mapping if event-based map missed it
    if (!resolvedPhoneJid && knownLidNumbers.has(cleanNumber) && session.client) {
      try {
        const repo = (session.client as any).signalRepository;
        if (repo?.lidMapping?.getPNForLID) {
          const pn = await repo.lidMapping.getPNForLID(`${cleanNumber}@lid`);
          if (pn) {
            resolvedPhoneJid = String(pn).includes('@') ? String(pn) : `${pn}@s.whatsapp.net`;
            lidToPhoneJid.set(cleanNumber, resolvedPhoneJid);
            console.log(`[Gateway] LID resolved via signalRepository: ${cleanNumber} → ${resolvedPhoneJid}`);
          }
        }
      } catch (resolveErr) {
        console.warn(`[Gateway] signalRepository LID lookup failed:`, resolveErr);
      }
    }
 
    if (to.includes('@')) {
      // Caller passed a full JID (e.g. number@lid or number@s.whatsapp.net) — use it directly
      targetJid = to.replace('@c.us', '@s.whatsapp.net');
    } else if (resolvedPhoneJid) {
      // We have a confirmed real phone JID from the mapping
      targetJid = resolvedPhoneJid.includes('@') ? resolvedPhoneJid : `${resolvedPhoneJid}@s.whatsapp.net`;
      console.log(`[Gateway] Resolved LID ${cleanNumber} → ${targetJid}`);
    } else if (knownLidNumbers.has(cleanNumber)) {
      // ✅ Baileys docs: send to @lid directly — Baileys resolves it internally
      targetJid = `${cleanNumber}@lid`;
      console.log(`[Gateway] Known LID, sending to @lid JID directly: ${targetJid}`);
    } else {
      // Regular phone number
      targetJid = `${cleanNumber}@s.whatsapp.net`;
    }
    
    console.log(`[Gateway] Sending message to JID: ${targetJid} for account ${accountId} (lidResolved: ${!!resolvedPhoneJid})`);
    
    let content: AnyMessageContent;
    if (mediaUrl && mediaType) {
      if (mediaType === 'image') {
        content = { image: { url: mediaUrl }, caption: text || undefined };
      } else if (mediaType === 'audio') {
        content = { audio: { url: mediaUrl }, mimetype: 'audio/mp4', ptt: true };
      } else if (mediaType === 'video') {
        content = { video: { url: mediaUrl }, caption: text || undefined };
      } else if (mediaType === 'document') {
        const parts = (filename || '').split('.');
        const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : '';
        let mime = 'application/octet-stream';
        if (ext === 'pdf') mime = 'application/pdf';
        else if (ext === 'doc' || ext === 'docx') mime = 'application/msword';
        else if (ext === 'xls' || ext === 'xlsx') mime = 'application/vnd.ms-excel';
        else if (ext === 'png') mime = 'image/png';
        else if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
        content = { document: { url: mediaUrl }, mimetype: mime, fileName: filename || 'Document', caption: text || undefined };
      } else {
        content = { text: text || '' };
      }
    } else {
      content = { text: text || '' };
    }
    
    // If a custom messageId is provided, pass it to Baileys options
    const options = messageId ? { messageId } : undefined;
    
    const result = await session.client.sendMessage(targetJid, content, options);
    
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
