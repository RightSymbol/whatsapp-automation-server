const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrImage = require('qr-image');

const app = express();
app.use(express.json());

let qrCodeData = '';

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('--- NEW QR CODE GENERATED ---');
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
});

// QR Code को इमेज के रूप में देखने का नया फ़ीचर
app.get('/qr', (req, res) => {
    if (!qrCodeData) return res.send('QR Code ready nahi hai ya WhatsApp pehle se connected hai.');
    const code = qrImage.image(qrCodeData, { type: 'png' });
    res.type('png');
    code.pipe(res);
});

client.on('ready', () => {
    console.log('WhatsApp Client is Ready!');
    qrCodeData = '';
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    try {
        const chatId = phone.substring(1) + "@c.us";
        await client.sendMessage(chatId, message);
        res.status(200).json({ status: 'success', message: 'Message sent!' });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

client.initialize();
