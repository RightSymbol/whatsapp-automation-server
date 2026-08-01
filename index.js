import makeWASocket, { DisconnectReason, delay, Browsers, initAuthCreds, proto } from '@whiskeysockets/baileys';
import express from 'express';
import qrImage from 'qr-image';
import nodemailer from 'nodemailer';
import mongoose from 'mongoose';

const app = express();
app.use(express.json());

let sock;
let qrCodeData = '';

// 🍃 1. MONGODB CONFIGURATION & SESSION SCHEMA
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ ERROR: MONGO_URI Environment Variable is not set on Render!');
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log('🍃 Connected to MongoDB successfully!'))
        .catch((err) => console.log('❌ MongoDB Connection Error:', err));
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
            if (sessionCache.has(id)) {
                return sessionCache.get(id);
            }
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
            console.log(`Error writing session data for ${id}:`, error);
        }
    };

    const removeData = async (id) => {
        try {
            sessionCache.delete(id);
            await SessionModel.deleteOne({ id });
        } catch (error) {
            console.log(`Error deleting session data for ${id}:`, error);
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
                            if (value) {
                                tasks.push(writeData(key, value));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
}

// 📧 2. EMAIL ALERT SETTINGS
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'YOUR_EMAIL@gmail.com',
        pass: process.env.EMAIL_PASS || 'YOUR_GMAIL_APP_PASSWORD'
    }
});

const ADMIN_EMAIL = process.env.EMAIL_USER || 'YOUR_EMAIL@gmail.com';
const ADMIN_PHONE = '917065150744@s.whatsapp.net';

async function sendEmailAlert(subject, text) {
    try {
        await transporter.sendMail({
            from: `"WhatsApp API Alert" <${ADMIN_EMAIL}>`,
            to: ADMIN_EMAIL,
            subject: subject,
            text: text
        });
        console.log('📧 Email Alert Sent Successfully!');
    } catch (err) {
        console.log('❌ Failed to send email alert:', err.message);
    }
}

// 🚀 3. WHATSAPP CONNECTION LOGIC
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMongoDBAuthState();

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

        if (qr) {
            qrCodeData = qr;
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`❌ WhatsApp Disconnected! Code: ${statusCode}`);

            if (statusCode === DisconnectReason.loggedOut) {
                sessionCache.clear();
                await SessionModel.deleteMany({});
                console.log('🧹 Session cleared from MongoDB after logout.');
            }

            sendEmailAlert(
                '🚨 ALERT: WhatsApp Disconnected!',
                `WhatsApp Server disconnect ho gaya hai.\nReason Code: ${statusCode}\nAutomatic reconnecting...`
            );

            if (shouldReconnect) {
                console.log('Reconnecting automatically...');
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected & Session Synced to MongoDB!');
            qrCodeData = '';

            try {
                await delay(3000);
                await sock.sendMessage(ADMIN_PHONE, {
                    text: '🟢 *SERVER ALERT: WhatsApp Connected Successfully!*\n\nSession MongoDB mein secure hai. Ab kabhi logout nahi hoga! 🚀'
                });
            } catch (err) {
                console.log('WhatsApp alert error:', err.message);
            }

            sendEmailAlert(
                '🟢 SUCCESS: WhatsApp Connected!',
                'Aapka WhatsApp API Server connected hai aur session MongoDB mein permanent save ho chuka hai.'
            );
        }
    });
}

// 🌐 4. API ENDPOINTS

app.get('/pairing-code', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) {
        return res.status(400).send('Please add phone number! Example: /pairing-code?phone=917065150744');
    }

    try {
        if (!sock) return res.status(500).send('Socket not ready. Retry in 10 seconds.');

        await delay(3000);
        const cleanNumber = phone.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanNumber);

        res.send(`
            <div style="font-family:sans-serif; text-align:center; padding:40px;">
                <h2>Your WhatsApp Pairing Code:</h2>
                <h1 style="background:#25D366; color:white; display:inline-block; padding:10px 20px; border-radius:10px; letter-spacing:5px;">${code}</h1>
                <p>Open WhatsApp ➔ Linked Devices ➔ Link with phone number instead ➔ Enter this code!</p>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Error generating pairing code: ' + err.message);
    }
});

app.get('/qr', (req, res) => {
    if (!qrCodeData) {
        return res.send('<h3 style="font-family:sans-serif; text-align:center; margin-top:50px;">WhatsApp connected hai ya Code ban raha hai... Page refresh karein!</h3>');
    }
    const code = qrImage.image(qrCodeData, { type: 'png' });
    res.type('png');
    code.pipe(res);
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    try {
        if (!sock || sock.ws.readyState !== 1) {
            return res.status(503).json({
                status: 'error',
                error: 'WhatsApp connection is reconnecting. Please retry in 5 seconds.'
            });
        }

        const id = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(id, { text: message });

        res.status(200).json({ status: 'success', message: 'Message sent successfully!' });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    connectToWhatsApp();
});
