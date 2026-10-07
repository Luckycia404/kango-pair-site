const { makeid } = require('./id');
const QRCode = require('qrcode');
const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { sendPairingMessage } = require('./pairing-message');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    jidNormalizedUser,
    Browsers,
    delay,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const router = express.Router();
const logger = pino({ level: 'silent' });
const QR_SESSION_TIMEOUT_MS = 120000;
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
        console.error('[QR] Could not clean up temporary auth state:', error.message);
    }
}

function closeSocket(sock) {
    try {
        sock?.ws?.close();
    } catch (error) {
        console.warn('[QR] Socket close warning:', error.message);
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
    res.set('Cache-Control', 'no-store, max-age=0');
    const prefix = req.query.prefix === 'Riam' ? 'Riam' : 'Kango';

    const id = makeid(12);
    const sessionDir = path.join(__dirname, 'temp', id);
    let sock;
    let qrSent = false;
    let cleaned = false;
    let finalizing = false;
    let sessionTimer;
    let reconnectTimer;
    let reconnectAttempts = 0;

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(sessionTimer);
        clearTimeout(reconnectTimer);
        removeFile(sessionDir);
    };

    const closeAndCleanup = () => {
        clearTimeout(sessionTimer);
        clearTimeout(reconnectTimer);
        closeSocket(sock);
        cleanup();
    };

    sessionTimer = setTimeout(() => {
        if (!res.headersSent && !res.writableEnded) {
            res.status(504).json({ code: 'QR session expired. Please generate a new code.' });
        }
        closeAndCleanup();
    }, QR_SESSION_TIMEOUT_MS);

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
            console.warn(`[QR] Reconnecting after close ${statusCode || 'unknown'} in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}).`);
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (cleaned || finalizing) return;
                try {
                    startSocket();
                } catch (error) {
                    console.error('[QR] Could not restart the WhatsApp socket:', error.message);
                    if (!res.headersSent && !res.writableEnded) {
                        res.status(503).json({ code: 'Service Currently Unavailable' });
                    }
                    closeAndCleanup();
                }
            }, delayMs);
            return true;
        };

        const handleConnectionUpdate = async (socket, { connection, lastDisconnect, qr }) => {
            if (cleaned) return;

            if (qr && !qrSent && !res.headersSent && !res.writableEnded) {
                qrSent = true;
                try {
                    const png = await QRCode.toBuffer(qr);
                    if (!cleaned && !res.headersSent && !res.writableEnded) {
                        res.type('png').send(png);
                    }
                } catch (error) {
                    console.error('[QR] Could not encode the QR code:', error.message);
                    if (!res.headersSent && !res.writableEnded) {
                        res.status(503).json({ code: 'Service Currently Unavailable' });
                    }
                    closeAndCleanup();
                    return;
                }
            }

            if (connection === 'open' && !finalizing) {
                finalizing = true;
                clearTimeout(sessionTimer);
                clearTimeout(reconnectTimer);
                try {
                    const imageDeliveryStatus = await sendSession(socket, sessionDir, prefix);
                    console.log(`[QR] Session message sent; follow-up image status: ${imageDeliveryStatus}.`);
                } catch (error) {
                    console.error('[QR] Could not send the session:', error.message);
                } finally {
                    closeSocket(socket);
                    cleanup();
                }
                return;
            }

            if (connection === 'close' && !finalizing) {
                const statusCode = getDisconnectStatusCode(lastDisconnect?.error);
                console.warn(`[QR] Connection closed${statusCode ? ` (${statusCode})` : ''}.`);
                if (scheduleReconnect(statusCode)) return;
                if (!res.headersSent && !res.writableEnded) {
                    res.status(503).json({ code: 'Service Currently Unavailable' });
                }
                closeAndCleanup();
            }
        };

        startSocket();
    } catch (error) {
        console.error('[QR] Could not start the QR session:', error.message);
        if (!res.headersSent && !res.writableEnded) {
            res.status(503).json({ code: 'Service Currently Unavailable' });
        }
        closeAndCleanup();
    }
});

module.exports = router;
