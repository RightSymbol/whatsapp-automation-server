const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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

// QR Code Endpoint
app.get('/qr', (req, res) => {
    if (!qrCodeData) {
        return res.send('<h3 style="font-family:sans-serif; text-align:center; margin-top:50px;">WhatsApp connected hai ya QR code ban raha hai... 10 sec baad Page refresh karein!</h3>');
    }
    const code = qrImage.image(qrCodeData, { type: 'png' });
    res.type('png');
    code.pipe(res);
});

// Send Message Endpoint for Pabbly Connect
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
