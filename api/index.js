const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');

// Base64 ডিকোড করার ফাংশন
const atob = (b64) => Buffer.from(b64, 'base64').toString('utf-8');

// Vercel ড্যাশবোর্ড থেকে এনভায়রনমেন্ট ভেরিয়েবল রিড করবে
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || atob("MDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQ=");
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || atob("NjhmN2E0NDYxY2VjNTc1Mjk0YTY2YjliZTlkOTkxODNhMzllMjU1YzkwZDU1ZTdkZmY2ZTJhNzgzOTQ5NmI2ZQ==");
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || atob("ODliODZkOGY1OTgxMjlkYWUyYmVkMjg1MjdjN2U1ZjI=");
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || atob("aHR0cHM6Ly9wdWItMDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQucjIuZGV2");
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "media";

// Supabase Environment Variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const app = express();

app.use(cors());
app.use(express.json());

// Initialize Supabase
let supabase;
try {
    if (SUPABASE_URL && SUPABASE_KEY) {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    }
} catch (e) {
    console.error("Supabase Init Error:", e.message);
}

// মেমোরি স্টোরেজ কনফিগারেশন
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 200 * 1024 * 1024 },
});

// Cloudflare R2 ক্লায়েন্ট
const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Backend is running with Supabase Auth and Cloudflare R2!',
        supabaseConfigured: !!supabase
    });
});

// ==========================================
// AUTHENTICATION ROUTES (Supabase)
// ==========================================
const handleLogin = async (req, res) => {
    const { email, password } = req.body;
    if (!supabase) return res.status(500).json({ success: false, message: "Supabase not configured on server (Missing ENV variables)" });
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
    if (!supabase) return res.status(500).json({ success: false, message: "Supabase not configured on server (Missing ENV variables)" });
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

// ==========================================
// FILE UPLOAD ROUTES (Cloudflare R2)
// ==========================================
const uploadWithRetry = async (command, maxRetries = 3) => {
    let lastError = null;
    const delays = [1000, 3000, 5000];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await s3.send(command);
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, delays[attempt - 1] || 5000));
            }
        }
    }
    throw lastError;
};

app.post('/api/upload', upload.single('media'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No media file provided.' });
    }
    const ext = req.file.originalname.split('.').pop();
    const uniqueName = `upload_${Date.now()}_${uuidv4()}.${ext}`;

    try {
        const cmd = new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: uniqueName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        });

        await uploadWithRetry(cmd, 3);
        res.status(201).json({
            message: 'Media uploaded successfully',
            media: { url: `${R2_PUBLIC_URL}/${uniqueName}` }
        });
    } catch (e) {
        res.status(500).json({ error: 'Storage upload failed', details: e.message });
    }
});

// Presigned URL (For large video direct uploads)
app.post('/api/get-presigned-url', async (req, res) => {
    const { filename, contentType } = req.body;
    if (!filename || !contentType) {
        return res.status(400).json({ error: 'filename and contentType are required' });
    }

    const ext = filename.split('.').pop();
    const uniqueName = `upload_${Date.now()}_${uuidv4()}.${ext}`;

    try {
        const cmd = new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: uniqueName,
            ContentType: contentType,
        });

        // Generate URL valid for 1 hour
        const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
        res.status(200).json({
            presignedUrl: presignedUrl,
            fileUrl: `${R2_PUBLIC_URL}/${uniqueName}`
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to generate presigned URL', details: e.message });
    }
});

// Export as serverless function
module.exports = app;
