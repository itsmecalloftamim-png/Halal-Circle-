const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const atob = (b64) => Buffer.from(b64, 'base64').toString('utf-8');

// R2 Credentials
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || atob("MDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQ=");
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || atob("NjhmN2E0NDYxY2VjNTc1Mjk0YTY2YjliZTlkOTkxODNhMzllMjU1YzkwZDU1ZTdkZmY2ZTJhNzgzOTQ5NmI2ZQ==");
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || atob("ODliODZkOGY1OTgxMjlkYWUyYmVkMjg1MjdjN2U1ZjI=");
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || atob("aHR0cHM6Ly9wdWItMDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQucjIuZGV2");
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "media";

// Supabase & Telegram Credentials (Vercel Dashboard Environment Variables থেকে নিবে)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const app = express();
app.use(cors());
app.use(express.json());

// Supabase Init
let supabase;
try {
    if (SUPABASE_URL && SUPABASE_KEY) {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    } else {
        console.log("Supabase credentials not found in environment variables.");
    }
} catch (e) {
    console.error("Supabase Init Error:", e.message);
}

// R2 Init
const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Backend is running with Supabase Auth and R2 Uploads!' });
});

// -------------- AUTH ROUTES --------------

const handleLogin = async (req, res) => {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ success: false, message: "Supabase not configured on server" });
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        res.json({ success: true, message: "Logged in successfully", userId: data.user.id });
    } catch (error) {
        res.status(401).json({ success: false, message: error.message });
    }
};

const handleSignup = async (req, res) => {
    const { email, password, fullName } = req.body;
    if (!supabase) return res.status(500).json({ success: false, message: "Supabase not configured on server" });
    try {
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { full_name: fullName || 'User' } }
        });
        if (error) throw error;
        res.json({ success: true, message: "Account created successfully", userId: data?.user?.id });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

app.post('/api/login', handleLogin);
app.post('/api/auth/login', handleLogin);
app.post('/api/signup', handleSignup);
app.post('/api/auth/signup', handleSignup);


// -------------- TELEGRAM ROUTE --------------

app.post('/api/send-transaction', async (req, res) => {
    const { amount, transactionId, category, userEmail } = req.body;
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return res.status(500).json({ success: false, message: "Telegram not configured on server" });
    }
    const message = `🔔 *নতুন ট্রানজেকশন*\n💰 *পরিমাণ:* ${amount} BDT\n📝 *ID:* ${transactionId}\n📧 *ইউজার:* ${userEmail}`;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        res.json({ success: true, message: "Sent to Telegram" });
    } catch (error) {
        res.status(400).json({ success: false, message: "Telegram Error" });
    }
});


// -------------- R2 UPLOAD ROUTES --------------

const uploadWithRetry = async (command, maxRetries = 3) => {
    let lastError = null;
    const delays = [1000, 3000, 5000];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try { return await s3.send(command); }
        catch (error) {
            lastError = error;
            if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, delays[attempt - 1] || 5000));
        }
    }
    throw lastError;
};

app.post('/api/upload', upload.single('media'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No media file provided.' });
    const ext = req.file.originalname.split('.').pop();
    const uniqueName = `upload_${Date.now()}_${uuidv4()}.${ext}`;
    try {
        const cmd = new PutObjectCommand({
            Bucket: R2_BUCKET_NAME, Key: uniqueName, Body: req.file.buffer, ContentType: req.file.mimetype,
        });
        await uploadWithRetry(cmd, 3);
        res.status(201).json({ message: 'Media uploaded successfully', media: { url: `${R2_PUBLIC_URL}/${uniqueName}` } });
    } catch (e) {
        res.status(500).json({ error: 'Upload failed', details: e.message });
    }
});

app.post('/api/get-presigned-url', async (req, res) => {
    const { filename, contentType } = req.body;
    if (!filename || !contentType) return res.status(400).json({ error: 'filename and contentType required' });
    const ext = filename.split('.').pop();
    const uniqueName = `upload_${Date.now()}_${uuidv4()}.${ext}`;
    try {
        const cmd = new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: uniqueName, ContentType: contentType });
        const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
        res.status(200).json({ presignedUrl, fileUrl: `${R2_PUBLIC_URL}/${uniqueName}` });
    } catch (e) {
        res.status(500).json({ error: 'Failed to generate presigned URL', details: e.message });
    }
});

// -------------- GLOBAL ERROR HANDLER --------------
app.use((err, req, res, next) => {
    res.status(500).json({ success: false, message: "Internal Server Error", error: err.message });
});

module.exports = app;
