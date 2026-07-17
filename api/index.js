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

const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');

const atob = (b64) => Buffer.from(b64, 'base64').toString('utf-8');

// Cloudflare R2 Credentials
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || atob("MDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQ=");
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || atob("NjhmN2E0NDYxY2VjNTc1Mjk0YTY2YjliZTlkOTkxODNhMzllMjU1YzkwZDU1ZTdkZmY2ZTJhNzgzOTQ5NmI2ZQ==");
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || atob("ODliODZkOGY1OTgxMjlkYWUyYmVkMjg1MjdjN2U1ZjI=");
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || atob("aHR0cHM6Ly9wdWItMDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQucjIuZGV2");
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "media";

const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

const upload = multer({ storage: multer.memoryStorage() });

// ১. নতুন ডিরেক্ট আপলোড রাউট (বড় ভিডিও/ছবির জন্য)
app.post('/api/get-presigned-url', async (req, res) => {
    const { filename, contentType } = req.body;
    if (!filename || !contentType) return res.status(400).json({ error: 'Missing data' });

    const ext = filename.split('.').pop();
    const uniqueName = `upload_${Date.now()}_${uuidv4()}.${ext}`;

    try {
        const cmd = new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: uniqueName, ContentType: contentType });
        const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
        res.status(200).json({ presignedUrl, fileUrl: `${R2_PUBLIC_URL}/${uniqueName}` });
    } catch (e) {
        res.status(500).json({ error: 'Presigned URL error' });
    }
});

// ২. ফলব্যাক আপলোড রাউট (উভয় file ও media ফিল্ড সাপোর্ট করার জন্য)
app.post('/api/upload', upload.any(), async (req, res) => {
    const file = req.files && req.files[0];
    if (!file) return res.status(400).json({ error: 'No media file provided.' });

    const ext = file.originalname.split('.').pop();
    const uniqueName = `upload_${Date.now()}_${uuidv4()}.${ext}`;

    try {
        const cmd = new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: uniqueName, Body: file.buffer, ContentType: file.mimetype });
        await s3.send(cmd);
        res.status(201).json({ url: `${R2_PUBLIC_URL}/${uniqueName}` });
    } catch (e) {
        res.status(500).json({ error: 'Upload failed' });
    }
});

module.exports = app;
