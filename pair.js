const { makeid } = require('./id');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { sendPairingMessage } = require('./pairing-message');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const router = express.Router();
const logger = pino({ level: 'silent' });
const REQUEST_TIMEOUT_MS = 120000;
const CREDENTIAL_TIMEOUT_MS = 15000;
const MAX_RECONNECT_ATTEMPTS = 4;
const STOP_RECONNECT_CODES = new Set([
    DisconnectReason.loggedOut,
    DisconnectReason.badSession,
    DisconnectReason.forbidden,
    DisconnectReason.multideviceMismatch,
    DisconnectReason.connectionReplaced
]);

function getDisconnectStatusCode(error) {
    const value = error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode;
    const statusCode = Number(value);
    return Number.isFinite(statusCode) && statusCode > 0 ? statusCode : undefined;
}

function removeFile(filePath) {
    try {
        fs.rmSync(filePath, { recursive: true, force: true });
    } catch (error) {
        console.error('[Pair] Could not clean up temporary auth state:', error.message);
    }
}

function closeSocket(sock) {
    try {
        sock?.ws?.close();
    } catch (error) {
        console.warn('[Pair] Socket close warning:', error.message);
    }
}

async function readCredentials(sessionDir) {
    const credsPath = path.join(sessionDir, 'creds.json');
    const deadline = Date.now() + CREDENTIAL_TIMEOUT_MS;
    let lastError;

    while (Date.now() < deadline) {
        try {
            const data = await fs.promises.readFile(credsPath);
            JSON.parse(data.toString('utf8'));
            return data;
        } catch (error) {
            lastError = error;
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await delay(300);
    }

    throw new Error(`WhatsApp credentials were not ready in time${lastError ? `: ${lastError.message}` : ''}`);
}

async function sendSession(sock, sessionDir, prefix) {
    await delay(5000);
    const data = await readCredentials(sessionDir);
    const socketUserId = sock.user?.id;
    if (!socketUserId) throw new Error('WhatsApp did not provide a linked account ID.');

    const userJid = jidNormalizedUser(socketUserId);
    const sessionMessage = await sock.sendMessage(userJid, {
        text: `${prefix.toUpperCase()}~${data.toString('base64')}`
    });
    return sendPairingMessage(sock, userJid, sessionMessage, prefix);
}

router.get('/', async (req, res) => {
    const number = String(req.query.number || '').replace(/\D/g, '');
    const prefix = req.query.prefix === 'Riam' ? 'Riam' : 'Kango';
    if (number.length < 10 || number.length > 15) {
        return res.status(400).json({ code: 'Enter a valid phone number with its country code.' });
    }

    const id = makeid(12);
    const sessionDir = path.join(__dirname, 'temp', id);
    let sock;
    let cleaned = false;
    let finalizing = false;
    let requestTimer;
    let reconnectTimer;
    let reconnectAttempts = 0;

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(requestTimer);
        clearTimeout(reconnectTimer);
        removeFile(sessionDir);
    };

    const closeAndCleanup = () => {
        clearTimeout(requestTimer);
        clearTimeout(reconnectTimer);
        closeSocket(sock);
        cleanup();
    };

    requestTimer = setTimeout(() => {
        if (!res.headersSent && !res.writableEnded) {
            res.status(504).json({ code: 'Pairing request expired. Generate a new code and try again.' });
        }
        closeAndCleanup();
    }, REQUEST_TIMEOUT_MS);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        if (cleaned) return;
        const { version } = await fetchLatestBaileysVersion();
        if (cleaned) return;

        const startSocket = () => {
            const socket = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
                logger,
                browser: Browsers.ubuntu('Chrome'),
                markOnlineOnConnect: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5
            });
            sock = socket;
            socket.ev.on('creds.update', saveCreds);
            socket.ev.on('connection.update', (update) => {
                void handleConnectionUpdate(socket, update);
            });
            return socket;
        };

        const scheduleReconnect = (statusCode) => {
            if (cleaned || finalizing) return false;
            if (reconnectTimer) return true;
            if (STOP_RECONNECT_CODES.has(statusCode) || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return false;

            reconnectAttempts += 1;
            const delayMs = statusCode === DisconnectReason.restartRequired ? 6000 : 3000;
            console.warn(`[Pair] Reconnecting after close ${statusCode || 'unknown'} in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}).`);
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (cleaned || finalizing) return;
                try {
                    startSocket();
                } catch (error) {
                    console.error('[Pair] Could not restart the WhatsApp socket:', error.message);
                    if (!res.headersSent && !res.writableEnded) {
                        res.status(503).json({ code: 'Service Currently Unavailable' });
                    }
                    closeAndCleanup();
                }
            }, delayMs);
            return true;
        };

        const handleConnectionUpdate = async (socket, { connection, lastDisconnect }) => {
            if (cleaned) return;

            if (connection === 'open' && !finalizing) {
                finalizing = true;
                clearTimeout(requestTimer);
                clearTimeout(reconnectTimer);
                try {
                    const imageDeliveryStatus = await sendSession(socket, sessionDir, prefix);
                    console.log(`[Pair] Session message sent; follow-up image status: ${imageDeliveryStatus}.`);
                } catch (error) {
                    console.error('[Pair] Could not send the session:', error.message);
                } finally {
                    closeSocket(socket);
                    cleanup();
                }
                return;
            }

            if (connection === 'close' && !finalizing) {
                const statusCode = getDisconnectStatusCode(lastDisconnect?.error);
                console.warn(`[Pair] Connection closed${statusCode ? ` (${statusCode})` : ''}.`);
                if (scheduleReconnect(statusCode)) return;
                if (!res.headersSent && !res.writableEnded) {
                    res.status(503).json({ code: 'Service Currently Unavailable' });
                }
                closeAndCleanup();
            }
        };

        startSocket();

        if (state.creds.registered) {
            throw new Error('A new pairing session was unexpectedly already registered.');
        }

        await delay(3000);
        if (cleaned || res.headersSent || res.writableEnded) return;

        const rawCode = await sock.requestPairingCode(number);
        const normalizedCode = String(rawCode || '').replace(/[^A-Za-z0-9]/g, '');
        if (!normalizedCode) throw new Error('WhatsApp returned an empty pairing code.');
        const formattedCode = normalizedCode.match(/.{1,4}/g)?.join('-') || normalizedCode;

        if (!res.headersSent && !res.writableEnded) {
            res.json({ code: formattedCode, id });
        }
    } catch (error) {
        console.error('[Pair] Could not start the pairing session:', error.message);
        if (!res.headersSent && !res.writableEnded) {
            res.status(503).json({ code: 'Service Currently Unavailable' });
        }
        closeAndCleanup();
    }
});

module.exports = router;
