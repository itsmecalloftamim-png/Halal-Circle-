const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner'); // নতুন ইমপোর্ট
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

// CORS কনফিগারেশন - যাতে মোবাইল অ্যাপ থেকে কোনো বাধা ছাড়াই কানেক্ট হতে পারে
app.use(cors());
app.use(express.json());

// মেমোরি স্টোরেজ কনফিগারেশন
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 200 * 1024 * 1024 }, // সর্বোচ্চ ২০০ মেগাবাইট ফাইল সাইজ লিমিট
});

// Cloudflare R2 ক্লায়েন্ট ইনিশিয়ালাইজেশন
const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

// সার্ভার ঠিকঠাক চলছে কিনা তা চেক করার রুট
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Backend is running on Vercel with Cloudflare R2! Presigned URL enabled.' });
});

const uploadWithRetry = async (command, maxRetries = 3) => {
    let lastError = null;
    const delays = [1000, 3000, 5000];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[Upload] Attempt ${attempt} of ${maxRetries}...`);
            const response = await s3.send(command);
            console.log(`[Upload] Attempt ${attempt} successful!`);
            return response;
        } catch (error) {
            console.error(`[Upload] Attempt ${attempt} failed: ${error.message}`);
            lastError = error;
            if (attempt < maxRetries) {
                const delayMs = delays[attempt - 1] || 5000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastError;
};

// মেইন মিডিয়া আপলোড এন্ডপয়েন্ট (ছোট ফাইল এর জন্য আগের মতোই থাকবে)
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
        const fileUrl = `${R2_PUBLIC_URL}/${uniqueName}`;

        res.status(201).json({
            message: 'Media uploaded successfully',
            media: { url: fileUrl }
        });
    } catch (e) {
        console.error('Final R2 Upload Failure:', e);
        res.status(500).json({
            error: 'Storage upload completely failed after retries',
            details: e.message,
            diagnosticCode: e.name || 'UnknownException'
        });
    }
});

// নতুন Presigned URL এন্ডপয়েন্ট (বড় ভিডিও সরাসরি আপলোড করার জন্য)
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

        // ১ ঘণ্টার জন্য ভ্যালিড একটা ডিরেক্ট আপলোড লিঙ্ক তৈরি হবে
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

// Vercel-এর সার্ভারলেস ফাংশন হিসেবে এক্সপ্রেস অ্যাপলিকেশন এক্সপোর্ট করা
module.exports = app;app.post('/api/upload', upload.single('media'), async (req, res) => {
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
        const fileUrl = `${R2_PUBLIC_URL}/${uniqueName}`;

        res.status(201).json({
            message: 'Media uploaded successfully',
            media: { url: fileUrl }
        });
    } catch (e) {
        console.error('Final R2 Upload Failure:', e);
        res.status(500).json({
            error: 'Storage upload completely failed after retries',
            details: e.message
        });
    }
});

module.exports = app;
