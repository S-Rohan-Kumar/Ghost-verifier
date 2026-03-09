// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Upload Routes (Presigned S3 URLs)
//  routes/upload.js
// ═══════════════════════════════════════════════════════════════
import express                    from 'express';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl }           from '@aws-sdk/s3-request-presigner';

const router = express.Router();

// ── S3 Client ────────────────────────────────────────────────────
const s3 = new S3Client({
  region     : process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId    : process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.S3_BUCKET_NAME;

// ─────────────────────────────────────────────────────────────────
//  GET /api/upload/presigned-url
//  Query params:
//    type      — "thumbnail" | "video"
//    sessionId — the current session ID
//  Returns:
//    uploadUrl — presigned PUT URL (valid 5 minutes)
//    s3Key     — the S3 object key to store for reference
// ─────────────────────────────────────────────────────────────────
router.get('/presigned-url', async (req, res) => {
  try {
    const { type, sessionId } = req.query;

    if (!type || !sessionId) {
      return res.status(400).json({ error: 'type and sessionId are required query params' });
    }

    if (!['thumbnail', 'video'].includes(type)) {
      return res.status(400).json({ error: 'type must be "thumbnail" or "video"' });
    }

    const folder      = type === 'thumbnail' ? 'thumbnails' : 'videos';
    const ext         = type === 'thumbnail' ? 'jpg' : 'mp4';
    const contentType = type === 'thumbnail' ? 'image/jpeg' : 'video/mp4';

    // Key format: thumbnails/SESSION_ID_TIMESTAMP.jpg
    const s3Key = `${folder}/${sessionId}_${Date.now()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket     : BUCKET,
      Key        : s3Key,
      ContentType: contentType,
      // Tag files for lifecycle policy (optional but good practice)
      Tagging    : `sessionId=${sessionId}&type=${type}`
    });

    // Presigned URL valid for 5 minutes
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    console.log(`[upload] Generated presigned URL for ${type}: ${s3Key}`);

    res.json({ uploadUrl, s3Key, expiresIn: 300 });

  } catch (err) {
    console.error('[GET /upload/presigned-url]', err);
    res.status(500).json({ error: 'Failed to generate presigned URL', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/upload/view-url/:s3Key
//  Generate a presigned GET URL for viewing/playing a stored file.
//  Used by dashboard to play verification videos.
// ─────────────────────────────────────────────────────────────────
router.get('/view-url/:s3Key(*)', async (req, res) => {
  try {
    const { s3Key } = req.params;

    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key   : s3Key
    });

    // View URL valid for 1 hour
    const viewUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    res.json({ viewUrl, expiresIn: 3600 });

  } catch (err) {
    console.error('[GET /upload/view-url]', err);
    res.status(500).json({ error: 'Failed to generate view URL', message: err.message });
  }
});

export default router;
