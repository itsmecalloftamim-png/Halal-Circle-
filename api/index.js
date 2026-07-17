const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

// Base64 ডিকোড করার ফাংশন
const atob = (b64) => Buffer.from(b64, 'base64').toString('utf-8');

// Vercel ড্যাশবোর্ড থেকে এনভায়রনমেন্ট ভেরিয়েবল রিড করবে
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || atob("MDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQ=");
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || atob("NjhmN2E0NDYxY2VjNTc1Mjk0YTY2YjliZTlkOTkxODNhMzllMjU1YzkwZDU1ZTdkZmY2ZTJhNzgzOTQ5NmI2ZQ==");
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || atob("ODliODZkOGY1OTgxMjlkYWUyYmVkMjg1MjdjN2U1ZjI=");
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || atob("aHR0cHM6Ly9wdWItMDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQucjIuZGV2");
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "media";

// Supabase Credentials (Vercel-এ ENV হিসেবে সেভ করা থাকলে অটো কাজ করবে)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB Vercel parse limit bypass
});

const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

// হেলথ চেক রুট
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Backend is running with Cloudflare R2 & Supabase Auth!' });
});

// ==========================================
//           AUTH ROUTES (লগইন এবং সাইনআপ)
// ==========================================

app.post('/api/signup', async (req, res) => {
    try {
        const { email, password, fullName, username } = req.body;
        
        if (supabase) {
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        full_name: fullName,
                        username: username,
                    }
                }
            });
            
            if (error) return res.status(400).json({ success: false, message: error.message });
            return res.status(200).json({ success: true, message: "Signup successful", userId: data.user?.id });
        } else {
            // যদি Supabase কনফিগার করা না থাকে (Mock মোড)
            const mockId = `u_${Date.now()}`;
            return res.status(200).json({ success: true, message: "Mock signup successful", userId: mockId });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (supabase) {
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) return res.status(400).json({ success: false, message: error.message });
            return res.status(200).json({ success: true, message: "Login successful", userId: data.user?.id });
        } else {
            // যদি Supabase কনফিগার করা না থাকে (Mock মোড)
            const mockId = `u_${Date.now()}`;
            return res.status(200).json({ success: true, message: "Mock login successful", userId: mockId });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
//           UPLOAD ROUTES (ভিডিও/ছবি)
// ==========================================

// বড় ভিডিও আপলোডের জন্য (Presigned URL)
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

        const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
        const fileUrl = `${R2_PUBLIC_URL}/${uniqueName}`;

        res.status(200).json({
            presignedUrl: presignedUrl,
            fileUrl: fileUrl
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to generate presigned URL', details: e.message });
    }
});

// সাধারণ/ছোট ফাইল আপলোডের জন্য (Fallback)
app.post('/api/upload', upload.any(), async (req, res) => {
    const file = req.files && req.files[0];
    if (!file) {
        return res.status(400).json({ error: 'No media file provided.' });
    }

    const ext = file.originalname.split('.').pop();
    const uniqueName = `upload_${Date.now()}_${uuidv4()}.${ext}`;

    try {
        const cmd = new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: uniqueName,
            Body: file.buffer,
            ContentType: file.mimetype,
        });

        await s3.send(cmd);
        const fileUrl = `${R2_PUBLIC_URL}/${uniqueName}`;

        res.status(201).json({
            message: 'Media uploaded successfully',
            url: fileUrl,
            media: { url: fileUrl }
        });
    } catch (e) {
        res.status(500).json({ error: 'Storage upload failed', details: e.message });
    }
});

module.exports = app;        res.status(400).json({ success: false, message: "Telegram Error" });
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
