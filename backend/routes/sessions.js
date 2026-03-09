// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Sessions Routes
//  routes/sessions.js
// ═══════════════════════════════════════════════════════════════
import express  from 'express';
import Session  from '../models/Session.js';
import Business from '../models/Business.js';
import { io }   from '../index.js';
import {
  haversineDistance,
  computeInfraScore,
  computeSignageScore,
  computeTrustScore,
  deriveStatus,
  GEO_DISTANCE_THRESHOLD_METRES
} from '../config/scoring.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions
//  Called by React Native app when verification starts.
//  Creates a PENDING session and immediately computes geo score.
// ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      sessionId,
      businessId,
      businessName,
      gpsStart,
      gpsEnd,
      device,
      isRooted,
      accelerometer,
      appVersion
    } = req.body;

    // Validate required fields
    if (!sessionId || !businessId) {
      return res.status(400).json({ error: 'sessionId and businessId are required' });
    }

    // Block rooted devices immediately
    if (isRooted === true) {
      return res.status(403).json({
        error : 'DEVICE_COMPROMISED',
        message: 'Verification blocked: rooted/jailbroken device detected'
      });
    }

    // Look up registered address for this business
    let registeredCoords = null;
    let registeredAddress = '';
    const business = await Business.findOne({ businessId });

    if (business) {
      registeredCoords = {
        lat: business.registeredAddress.lat,
        lng: business.registeredAddress.lng
      };
      registeredAddress = business.registeredAddress.fullText || '';
    } else {
      // For hackathon: use a mock registered address if business not found
      // In production: return 404 or create business record
      registeredCoords = { lat: 12.9716, lng: 77.5946 }; // mock Bengaluru
      registeredAddress = 'Mock: Bengaluru, Karnataka';
    }

    // Compute geo score
    let geoScore = 0;
    let gpsDistanceMetres = null;

    if (gpsStart && registeredCoords) {
      gpsDistanceMetres = haversineDistance(gpsStart, registeredCoords);
      geoScore = gpsDistanceMetres <= GEO_DISTANCE_THRESHOLD_METRES ? 1 : 0;
    }

    // Create session in DB
    const session = await Session.create({
      sessionId,
      businessId,
      businessName,
      registeredAddress,
      status           : geoScore === 0 ? 'PROCESSING' : 'PROCESSING',
      geoScore,
      gpsDistanceMetres,
      meta: {
        device,
        isRooted  : isRooted ?? false,
        gpsStart,
        gpsEnd,
        accelerometer: accelerometer?.slice(0, 300) ?? [], // cap at 300 samples
        appVersion
      },
      auditLog: [{
        action: 'SESSION_CREATED',
        detail: `GPS distance: ${gpsDistanceMetres?.toFixed(0) ?? 'unknown'}m. Geo score: ${geoScore}`
      }]
    });

    // If geo fails → flag immediately without waiting for AI
    if (geoScore === 0) {
      await Session.findOneAndUpdate(
        { sessionId },
        {
          status    : 'FLAGGED',
          trustScore: 0,
          $push: { auditLog: { action: 'GEO_FAIL_FLAGGED', detail: `Distance ${gpsDistanceMetres?.toFixed(0)}m exceeds 100m threshold` } }
        }
      );
      // Emit early flag to dashboard
      io.emit('session_flagged_geo', {
        sessionId,
        businessId,
        businessName,
        gpsDistanceMetres,
        status: 'FLAGGED'
      });
    }

    res.status(201).json({
      success          : true,
      sessionId        : session.sessionId,
      geoScore,
      gpsDistanceMetres: gpsDistanceMetres ? parseFloat(gpsDistanceMetres.toFixed(1)) : null,
      immediatelyFlagged: geoScore === 0
    });

  } catch (err) {
    console.error('[POST /sessions]', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Session ID already exists' });
    }
    res.status(500).json({ error: 'Failed to create session', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions/ai-result
//  Called by AWS Lambda after Rekognition analysis completes.
//  Computes final trust score and emits Socket.io event.
// ─────────────────────────────────────────────────────────────────
router.post('/ai-result', async (req, res) => {
  try {
    const {
      s3Key,
      textDetected,
      labels,
      infraScore: rawInfraScore,
      isFlagged : isResidentialFlagged,
      livenessResult,
      timestamp
    } = req.body;

    // Extract sessionId from S3 key format: "thumbnails/SESSION_ID_timestamp.jpg"
    const filename  = s3Key.split('/')[1] || '';
    const sessionId = filename.split('_').slice(0, -1).join('_'); // everything before last _timestamp

    if (!sessionId) {
      return res.status(400).json({ error: 'Could not extract sessionId from s3Key' });
    }

    // Find the session
    const session = await Session.findOne({ sessionId });
    if (!session) {
      console.warn(`[ai-result] Session not found: ${sessionId}`);
      return res.status(404).json({ error: `Session not found: ${sessionId}` });
    }

    // If geo already failed, skip AI scoring (already FLAGGED)
    if (session.geoScore === 0) {
      return res.json({ success: true, message: 'Session already flagged by geo check, AI result stored only' });
    }

    // Compute signage score
    const signScore = computeSignageScore(textDetected, session.businessName);

    // Use the infra score Lambda computed (or recompute from labels)
    const { score: infraScore, flagged: labelFlagged, flaggedLabels } =
      computeInfraScore(labels);

    const isFlagged = isResidentialFlagged || labelFlagged;

    // Compute final trust score
    const trustScore = computeTrustScore({
      geoScore : session.geoScore,
      signScore,
      infraScore
    });

    const status = deriveStatus(trustScore, isFlagged, session.geoScore);

    // Update session with full AI results
    const updatedSession = await Session.findOneAndUpdate(
      { sessionId },
      {
        status,
        trustScore,
        signScore,
        infraScore,
        s3ThumbUri : s3Key,
        aiResults  : {
          textDetected,
          labels,
          infraScore,
          livenessResult: livenessResult ?? 'UNKNOWN',
          isFlagged
        },
        $push: {
          auditLog: {
            action: 'AI_RESULT_RECEIVED',
            detail : `Score: ${trustScore} | Status: ${status} | Labels: ${labels?.join(', ')} | Text: ${textDetected}`
          }
        }
      },
      { new: true }
    );

    // Update business summary record
    await Business.findOneAndUpdate(
      { businessId: session.businessId },
      {
        lastVerifiedAt : new Date(),
        lastTrustScore : trustScore,
        overallStatus  : status,
        $inc: { totalSessions: 0 } // don't increment here, was done at creation
      }
    );

    // Emit real-time event to dashboard + mobile app
    const payload = {
      sessionId,
      businessId  : session.businessId,
      businessName: session.businessName,
      trustScore,
      status,
      labels      : labels ?? [],
      textDetected,
      signScore   : parseFloat(signScore.toFixed(2)),
      infraScore  : parseFloat(infraScore.toFixed(2)),
      geoScore    : session.geoScore,
      flaggedLabels,
      isFlagged,
      timestamp   : new Date().toISOString()
    };

    io.emit('session_complete', payload);

    console.log(`[ai-result] ${sessionId} → Score: ${trustScore} | Status: ${status}`);

    res.json({
      success   : true,
      sessionId,
      trustScore,
      status,
      signScore,
      infraScore
    });

  } catch (err) {
    console.error('[POST /sessions/ai-result]', err);
    res.status(500).json({ error: 'Failed to process AI result', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/sessions
//  List all sessions with optional filtering.
// ─────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const {
      status,
      businessId,
      limit  = 100,
      offset = 0,
      sortBy = 'createdAt',
      order  = 'desc'
    } = req.query;

    const filter = {};
    if (status)     filter.status     = status;
    if (businessId) filter.businessId = businessId;

    const sessions = await Session
      .find(filter)
      .sort({ [sortBy]: order === 'asc' ? 1 : -1 })
      .skip(Number(offset))
      .limit(Number(limit))
      .select('-auditLog -meta.accelerometer'); // exclude heavy fields from list

    const total = await Session.countDocuments(filter);

    res.json({
      data   : sessions,
      total,
      limit  : Number(limit),
      offset : Number(offset)
    });

  } catch (err) {
    console.error('[GET /sessions]', err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/sessions/:id
//  Single session detail with full audit trail.
// ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) {
      return res.status(404).json({ error: `Session not found: ${req.params.id}` });
    }
    res.json(session);
  } catch (err) {
    console.error('[GET /sessions/:id]', err);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  PATCH /api/sessions/:id/review
//  Risk officer adds review notes.
// ─────────────────────────────────────────────────────────────────
router.patch('/:id/review', async (req, res) => {
  try {
    const { notes, reviewedBy, newStatus } = req.body;

    const update = {
      reviewNotes: notes,
      reviewedBy,
      reviewedAt : new Date(),
      $push: {
        auditLog: {
          action: 'MANUAL_REVIEW',
          detail : `Reviewed by ${reviewedBy}. Notes: ${notes}. Status changed to: ${newStatus ?? 'unchanged'}`
        }
      }
    };

    if (newStatus) update.status = newStatus;

    const session = await Session.findOneAndUpdate(
      { sessionId: req.params.id },
      update,
      { new: true }
    );

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    io.emit('session_reviewed', { sessionId: req.params.id, newStatus, reviewedBy });
    res.json({ success: true, session });

  } catch (err) {
    console.error('[PATCH /sessions/:id/review]', err);
    res.status(500).json({ error: 'Failed to update review' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  DELETE /api/sessions/:id  (dev/admin only)
// ─────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Delete not allowed in production' });
    }
    await Session.deleteOne({ sessionId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

export default router;
