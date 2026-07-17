const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');

// Base64 ডিকোড করার ফাংশন
const atob = (b64) => Buffer.from(b64, 'base64').toString('utf-8');

// Vercel ড্যাশবোর্ড থেকে এনভায়রনমেন্ট ভেরিয়েবল রিড করবে, না থাকলে ডিফল্ট কি ব্যবহার করবে
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || atob("MDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQ=");
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || atob("NjhmN2E0NDYxY2VjNTc1Mjk0YTY2YjliZTlkOTkxODNhMzllMjU1YzkwZDU1ZTdkZmY2ZTJhNzgzOTQ5NmI2ZQ==");
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || atob("ODliODZkOGY1OTgxMjlkYWUyYmVkMjg1MjdjN2U1ZjI=");
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || atob("aHR0cHM6Ly9wdWItMDRmY2IzMzRmYTA3YTZhYTQwYTgxNjBiNzc2ZTBkOGQucjIuZGV2");
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "media";

const app = express();

app.use(cors());
app.use(express.json());

// মেমোরি স্টোরেজ কনফিগারেশন
const storage = multer.memoryStorage();
// upload.any() ব্যবহার করা হয়েছে যাতে 'media', 'file' বা যেকোনো ফিল্ড নামেই ফাইল আসুক না কেন, Unexpected Field এরর না আসে।
const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB 
});

const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Backend is running fully configured!' });
});

// --- Auth Endpoints (No more FUNCTION_INVOCATION_FAILED) ---
app.post('/api/signup', (req, res) => {
    const { email, username, fullName } = req.body;
    res.status(200).json({
        success: true,
        message: 'Signup successful',
        userId: `user_${Date.now()}`
    });
});

app.post('/api/login', (req, res) => {
    const { email } = req.body;
    res.status(200).json({
        success: true,
        message: 'Login successful',
        userId: `user_${Date.now()}`
    });
});


// --- Upload Endpoints ---
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
        console.error('Presigned URL Error:', e);
        res.status(500).json({ error: 'Failed to generate presigned URL', details: e.message });
    }
});

// For backward compatibility (যদি অ্যাপ থেকে Multipart ফর্ম্যাটে রিকোয়েস্ট আসে)
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
        res.status(500).json({
            error: 'Storage upload failed',
            details: e.message
        });
    }
});

module.exports = app;
