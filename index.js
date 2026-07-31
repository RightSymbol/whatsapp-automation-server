const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const express = require('express');
const qrImage = require('qr-image');

const app = express();
app.use(express.json());

let sock;
let qrCodeData = '';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp Connected Successfully!');
            qrCodeData = '';
        }
    });
}

// 1. Phone Number Login / Pairing Code Endpoint (No QR needed!)
app.get('/pairing-code', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) {
        return res.status(400).send('Please add phone number! Example: /pairing-code?phone=917838436638');
    }
    
    try {
        if (!sock) return res.status(500).send('Socket not ready. Retry in 10 seconds.');
        
        // Wait a moment for socket connection
        await delay(2000);
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

// 2. QR Code Endpoint (Fallback)
app.get('/qr', (req, res) => {
    if (!qrCodeData) {
        return res.send('<h3 style="font-family:sans-serif; text-align:center; margin-top:50px;">WhatsApp connected hai ya Code ban raha hai... 10 sec baad Page refresh karein!</h3>');
    }
    const code = qrImage.image(qrCodeData, { type: 'png' });
    res.type('png');
    code.pipe(res);
});

// 3. Send Message Endpoint for Pabbly
app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    try {
        if (!sock) return res.status(500).json({ error: 'WhatsApp not initialized' });
        
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
