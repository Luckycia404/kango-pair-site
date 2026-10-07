const fs = require('fs');
const path = require('path');
const { WAMessageStatus } = require('@whiskeysockets/baileys');

const IMAGE_PATHS = {
    Kango: path.join(__dirname, 'assets', 'kango3.jpg'),
    Riam: path.join(__dirname, 'assets', 'queen-riam.png')
};
const DELIVERY_RECEIPT_TIMEOUT_MS = 8000;
const imagePromises = new Map();

function readPairingImage(prefix) {
    const key = prefix === 'Riam' ? 'Riam' : 'Kango';
    if (!imagePromises.has(key)) {
        const imagePromise = fs.promises.readFile(IMAGE_PATHS[key]).catch((error) => {
            imagePromises.delete(key);
            throw error;
        });
        imagePromises.set(key, imagePromise);
    }
    return imagePromises.get(key);
}

function getCaption(prefix) {
    const heading = prefix === 'Riam' ? 'QUEEN RIAM PAIR LINKED' : 'KANGO PAIR LINKED';
    const poweredBy = prefix === 'Riam' ? 'QUEEN RIAM' : 'KANGO PAIR';

    return `୨୧ *${heading}* ✦✨

Your WhatsApp session has been successfully connected!
Please keep your Session ID secure.

*COPY YOUR SESSION ID* — Copy the Session ID above and keep it safe 🔐

*NEXT STEPS:*

1. Copy the Session ID from the message above.
2. Open your bot's configuration.
3. Paste it into your session variable.
4. Save your settings and restart your bot. ✨

*CONTACT / SUPPORT*
Telegram: https://t.me/official_kango
WhatsApp: https://wa.me/233509977126

*COMMUNITY*
WhatsApp Channel: https://whatsapp.com/channel/0029Va8YUl50bIdtVMYnYd0E

*GITHUB*
https://github.com/Dev-Kango

---
Stay kind. Stay curious. Keep building. ✨

— *Powered by ${poweredBy}* 💙`;
}

function createDeliveryTracker(sock) {
    const eventEmitter = sock.ev;
    if (typeof eventEmitter?.on !== 'function' || typeof eventEmitter?.off !== 'function') {
        return null;
    }

    const statuses = new Map();
    const waiters = new Map();
    const onMessageUpdate = (updates) => {
        if (!Array.isArray(updates)) return;

        for (const { key, update } of updates) {
            const messageId = key?.id;
            const status = update?.status;
            if (!messageId || typeof status !== 'number') continue;

            statuses.set(messageId, status);
            if (status >= WAMessageStatus.DELIVERY_ACK || status === WAMessageStatus.ERROR) {
                waiters.get(messageId)?.(
                    status >= WAMessageStatus.DELIVERY_ACK ? 'delivered' : 'error'
                );
            }
        }
    };

    eventEmitter.on('messages.update', onMessageUpdate);

    return {
        waitForDelivery(messageId) {
            const status = statuses.get(messageId);
            if (typeof status === 'number') {
                return Promise.resolve(
                    status >= WAMessageStatus.DELIVERY_ACK ? 'delivered' : 'error'
                );
            }

            return new Promise((resolve) => {
                let timer;
                const finish = (deliveryStatus) => {
                    clearTimeout(timer);
                    waiters.delete(messageId);
                    resolve(deliveryStatus);
                };

                waiters.set(messageId, finish);
                timer = setTimeout(() => finish('timeout'), DELIVERY_RECEIPT_TIMEOUT_MS);
            });
        },
        dispose() {
            eventEmitter.off('messages.update', onMessageUpdate);
            for (const finish of waiters.values()) finish(false);
            waiters.clear();
        }
    };
}

async function sendPairingMessage(sock, userJid, quotedMessage, prefix = 'Kango') {
    if (!quotedMessage?.key) {
        throw new Error('The session ID message is not available to quote.');
    }

    const deliveryTracker = createDeliveryTracker(sock);
    if (!deliveryTracker) {
        throw new Error('WhatsApp delivery receipts are unavailable for the follow-up image.');
    }

    try {
        const image = await readPairingImage(prefix);
        const imageMessage = await sock.sendMessage(userJid, {
            image,
            caption: getCaption(prefix)
        }, {
            quoted: quotedMessage
        });

        if (!imageMessage?.key?.id) {
            throw new Error('WhatsApp did not return an ID for the follow-up image.');
        }

        const deliveryStatus = await deliveryTracker.waitForDelivery(imageMessage.key.id);
        if (deliveryStatus === 'delivered') {
            console.log('[Pairing] Follow-up image delivery confirmed.');
        } else if (deliveryStatus === 'error') {
            console.warn('[Pairing] WhatsApp reported an error for the follow-up image.');
        } else {
            console.warn('[Pairing] Follow-up image was submitted, but delivery was not confirmed within 8 seconds.');
        }
        return deliveryStatus;
    } finally {
        deliveryTracker.dispose();
    }
}

module.exports = { sendPairingMessage };