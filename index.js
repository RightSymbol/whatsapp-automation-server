const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const express = require('express');
const qrImage = require('qr-image');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

let sock;
let qrCodeData = '';

// 📧 1. EMAIL SETTINGS (अपनी ईमेल डिटेल्स डालें)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'YOUR_EMAIL@gmail.com',       // आपका Gmail Address
        pass: 'YOUR_GMAIL_APP_PASSWORD'     // Gmail का App Password (न नार्मल पासवर्ड)
    }
});

const ADMIN_EMAIL = 'YOUR_EMAIL@gmail.com'; // जिस ईमेल पर अलर्ट पाना चाहते हैं
const ADMIN_PHONE = '917065150744@s.whatsapp.net';

// 📩 Email Bhejne Ka Function
async function sendEmailAlert(subject, text) {
    try {
        await transporter.sendMail({
            from: '"WhatsApp API Alert" <YOUR_EMAIL@gmail.com>',
            to: ADMIN_EMAIL,
            subject: subject,
            text: text
        });
        console.log('📧 Email Alert Sent Successfully!');
    } catch (err) {
        console.log('❌ Failed to send email alert:', err.message);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
        }

        // 🔴 DISCONNECT EVENT (WhatsApp Disconnect Hone Par)
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`❌ WhatsApp Disconnected! Code: ${statusCode}`);

            // 📧 EMAIL ALERT: Jab Disconnect Ho
            sendEmailAlert(
                '🚨 ALERT: WhatsApp Disconnected!',
                `Aapka WhatsApp Server disconnect ho gaya hai.\nReason Code: ${statusCode}\n\nKripya naya Pairing Code ya QR Scan karke dubara connect karein.`
            );

            if (shouldReconnect) {
                console.log('Reconnecting automatically...');
                connectToWhatsApp();
            }
        } 
        
        // 🟢 CONNECT EVENT (WhatsApp Connect Hone Par)
        else if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
            qrCodeData = '';

            // WhatsApp Par Alert (Kyunki WhatsApp Online Hai)
            try {
                await delay(3000);
                await sock.sendMessage(ADMIN_PHONE, { 
                    text: '🟢 *SERVER ALERT: WhatsApp Connected Successfully!*\n\nAapki API online hai aur kaam kar rahi hai. 🚀' 
                });
            } catch (err) {
                console.log('WhatsApp alert error:', err.message);
            }

            // Email Par Bhi Confirmation Alert
            sendEmailAlert(
                '🟢 SUCCESS: WhatsApp Connected!',
                'Aapka WhatsApp API Server successfully connect ho chuka hai aur active hai.'
            );
        }
    });
}

// 1. Pairing Code Endpoint
app.get('/pairing-code', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) {
        return res.status(400).send('Please add phone number! Example: /pairing-code?phone=917065150744');
    }
    
    try {
        if (!sock) return res.status(500).send('Socket not ready. Retry in 10 seconds.');
        
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

// 2. QR Code Endpoint
app.get('/qr', (req, res) => {
    if (!qrCodeData) {
        return res.send('<h3 style="font-family:sans-serif; text-align:center; margin-top:50px;">WhatsApp connected hai ya Code ban raha hai... Page refresh karein!</h3>');
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
