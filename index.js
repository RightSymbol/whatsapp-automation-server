import makeWASocket, {
    DisconnectReason,
    delay,
    Browsers,
    initAuthCreds,
    proto
} from '@whiskeysockets/baileys';
import express from 'express';
import qrImage from 'qr-image';
import nodemailer from 'nodemailer';
import mongoose from 'mongoose';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// GLOBAL STATE
// ---------------------------------------------------------------------------
let sock = null;
let isConnecting = false;      // prevents two sockets being created at once
let qrCodeData = '';
let pairingCodeData = null;    // last generated pairing code (formatted)
let pairingRequestedFor = null; // phone number the current code belongs to
let pairingError = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | open

// ---------------------------------------------------------------------------
// 1. MONGODB CONFIGURATION & SESSION SCHEMA
// ---------------------------------------------------------------------------
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('❌ ERROR: MONGO_URI Environment Variable is not set on Render!');
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log('🍃 Connected to MongoDB successfully!'))
        .catch((err) => console.log('❌ MongoDB Connection Error:', err.message));
}

const SessionSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    data: { type: String, required: true }
});
const SessionModel = mongoose.model('Session', SessionSchema);

const sessionCache = new Map();

async function useMongoDBAuthState() {
    const readData = async (id) => {
        try {
            if (sessionCache.has(id)) return sessionCache.get(id);
            const result = await SessionModel.findOne({ id });
            if (!result) return null;
            const parsed = JSON.parse(result.data, (key, value) => {
                if (value && typeof value === 'object' && value.type === 'Buffer') {
                    return Buffer.from(value.data);
                }
                return value;
            });
            sessionCache.set(id, parsed);
            return parsed;
        } catch (error) {
            return null;
        }
    };

    const writeData = async (id, data) => {
        try {
            sessionCache.set(id, data);
            const value = JSON.stringify(data);
            await SessionModel.findOneAndUpdate(
                { id },
                { data: value },
                { upsert: true, new: true }
            );
        } catch (error) {
            console.log(`Error writing session data for ${id}:`, error.message);
        }
    };

    const removeData = async (id) => {
        try {
            sessionCache.delete(id);
            await SessionModel.deleteOne({ id });
        } catch (error) {
            console.log(`Error deleting session data for ${id}:`, error.message);
        }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            if (value) data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(key, value));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds),
        clearAll: async () => {
            sessionCache.clear();
            await SessionModel.deleteMany({});
        }
    };
}

// ---------------------------------------------------------------------------
// 2. EMAIL ALERTS
// ---------------------------------------------------------------------------
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const transporter = (EMAIL_USER && EMAIL_PASS)
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: EMAIL_USER, pass: EMAIL_PASS }
    })
    : null;

const ADMIN_PHONE_ENV = process.env.ADMIN_PHONE || '';
const ADMIN_PHONE = ADMIN_PHONE_ENV
    ? ADMIN_PHONE_ENV.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
    : null;

async function sendEmailAlert(subject, text) {
    if (!transporter) return;
    try {
        await transporter.sendMail({
            from: `"WhatsApp API Alert" <${EMAIL_USER}>`,
            to: EMAIL_USER,
            subject,
            text
        });
        console.log('📧 Email Alert Sent Successfully!');
    } catch (err) {
        console.log('❌ Failed to send email alert:', err.message);
    }
}

// ---------------------------------------------------------------------------
// 3. WHATSAPP CONNECTION LOGIC
// ---------------------------------------------------------------------------
async function connectToWhatsApp(phoneForPairing = null) {
    if (isConnecting) {
        console.log('⏳ Connection already in progress, skipping duplicate call.');
        return;
    }
    isConnecting = true;
    connectionStatus = 'connecting';
    pairingError = null;

    try {
        const { state, saveCreds, clearAll } = await useMongoDBAuthState();
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) qrCodeData = qr;

            if (connection === 'close') {
                connectionStatus = 'disconnected';
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`❌ WhatsApp Disconnected! Code: ${statusCode}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    await clearAll();
                    pairingCodeData = null;
                    pairingRequestedFor = null;
                    console.log('🧹 Session cleared from MongoDB after logout.');
                }

                sendEmailAlert(
                    '🚨 ALERT: WhatsApp Disconnected!',
                    `WhatsApp Server disconnect ho gaya hai.\nReason Code: ${statusCode}\nAutomatic reconnecting: ${shouldReconnect}`
                );

                sock = null;
                if (shouldReconnect) {
                    console.log('Reconnecting automatically in 5s...');
                    setTimeout(() => connectToWhatsApp(), 5000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'open';
                console.log('✅ WhatsApp Connected & Session Synced to MongoDB!');
                qrCodeData = '';
                pairingCodeData = null;
                pairingRequestedFor = null;

                if (ADMIN_PHONE) {
                    try {
                        await delay(3000);
                        await sock.sendMessage(ADMIN_PHONE, {
                            text: '🟢 *SERVER ALERT: WhatsApp Connected Successfully!*\n\nSession MongoDB mein secure hai. Ab kabhi logout nahi hoga! 🚀'
                        });
                    } catch (err) {
                        console.log('WhatsApp alert error:', err.message);
                    }
                }

                sendEmailAlert(
                    '🟢 SUCCESS: WhatsApp Connected!',
                    'Aapka WhatsApp API Server connected hai aur session MongoDB mein permanent save ho chuka hai.'
                );
            }
        });

        if (phoneForPairing && !state.creds.registered) {
            await delay(2000);
            try {
                const rawCode = await sock.requestPairingCode(phoneForPairing);
                pairingCodeData = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
                pairingRequestedFor = phoneForPairing;
                console.log(`🔑 Pairing code generated for ${phoneForPairing}: ${pairingCodeData}`);
            } catch (err) {
                console.log('❌ Pairing code request failed:', err.message);
                pairingError = err.message;
            }
        }
    } catch (err) {
        console.log('❌ connectToWhatsApp fatal error:', err.message);
        pairingError = err.message;
    } finally {
        isConnecting = false;
    }
}

// ---------------------------------------------------------------------------
// 4. API ENDPOINTS
// ---------------------------------------------------------------------------
app.get('/pairing-code', async (req, res) => {
    const rawPhone = req.query.phone;
    if (!rawPhone) {
        return res.status(400).send('Please add phone number! Example: /pairing-code?phone=917065150744');
    }
    const phone = rawPhone.replace(/[^0-9]/g, '');

    if (sock && sock.authState?.creds?.registered && connectionStatus === 'open') {
        return res.send('<h3 style="font-family:sans-serif;text-align:center;margin-top:50px;">WhatsApp pehle se connected hai! Naya number jodne ke liye pehle Linked Devices se logout karein.</h3>');
    }

    if (pairingCodeData && pairingRequestedFor === phone) {
        return res.send(renderPairingPage(pairingCodeData));
    }

    if (isConnecting) {
        return res.status(503).send('<h3 style="font-family:sans-serif;text-align:center;margin-top:50px;">Connection ban raha hai... 5 second baad page refresh karein.</h3>');
    }

    if (sock) {
        try { sock.end(undefined); } catch (_) {}
        sock = null;
    }

    pairingCodeData = null;
    pairingError = null;
    pairingRequestedFor = phone;

    connectToWhatsApp(phone);

    for (let i = 0; i < 12; i++) {
        await delay(1000);
        if (pairingCodeData && pairingRequestedFor === phone) {
            return res.send(renderPairingPage(pairingCodeData));
        }
        if (pairingError) {
            return res.status(500).send('Error generating pairing code: ' + pairingError + '. Page ko refresh karke dobara try karein.');
        }
    }

    return res.status(504).send('<h3 style="font-family:sans-serif;text-align:center;margin-top:50px;">Code generate hone mein zyada time lag raha hai. Page refresh karein.</h3>');
});

function renderPairingPage(code) {
    return `
        <div style="font-family:sans-serif; text-align:center; padding:40px; background:#f4f4f9; border-radius:15px; max-width:500px; margin:50px auto;">
            <h2 style="color:#333;">Your WhatsApp Pairing Code:</h2>
            <h1 style="background:#25D366; color:white; display:inline-block; padding:15px 25px; border-radius:10px; letter-spacing:6px; font-size:36px;">${code}</h1>
            <p style="color:#666; margin-top:20px;">Open WhatsApp ➔ Linked Devices ➔ <b>Link with phone number instead</b> ➔ Enter this code within 60 seconds!</p>
        </div>
    `;
}

app.get('/qr', (req, res) => {
    if (!qrCodeData) {
        if (!sock && !isConnecting) connectToWhatsApp();
        return res.send('<h3 style="font-family:sans-serif; text-align:center; margin-top:50px;">WhatsApp connected hai ya QR ban raha hai... 5 second baad page refresh karein!</h3>');
    }
    const code = qrImage.image(qrCodeData, { type: 'png' });
    res.type('png');
    code.pipe(res);
});

app.get('/status', (req, res) => {
    res.json({
        connectionStatus,
        isConnecting,
        registered: !!(sock && sock.authState?.creds?.registered),
        hasPendingPairingCode: !!pairingCodeData,
        pairingError
    });
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body || {};
    if (!phone || !message) {
        return res.status(400).json({ status: 'error', error: 'phone and message are required' });
    }
    try {
        if (!sock || connectionStatus !== 'open') {
            return res.status(503).json({
                status: 'error',
                error: 'WhatsApp is not connected right now. Please retry in a few seconds.'
            });
        }
        const id = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(id, { text: message });
        res.status(200).json({ status: 'success', message: 'Message sent successfully!' });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// ---------------------------------------------------------------------------
// 5. START SERVER
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    connectToWhatsApp();
});
