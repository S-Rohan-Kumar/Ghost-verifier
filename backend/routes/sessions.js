// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Sessions Routes
//  routes/sessions.js
//
//  Fixes applied:
//    ✅ gpsDistanceMetres + registeredAddress saved to DB
//    ✅ signScore uses fuzzy word matching (not hardcoded 0.85/0.20)
//    ✅ PATCH /review uses $set correctly (no MongoServerError)
//    ✅ Layer 1 — Liveness enforcement (SPOOF_DETECTED / SUSPICIOUS)
//    ✅ Layer 3 — Screen recording enforcement (phone+screen pair)
// ═══════════════════════════════════════════════════════════════
import express  from "express";
import Session  from "../models/Session.js";
import Business from "../models/Business.js";
import { io }   from "../index.js";
import {
  haversineDistance,
  computeSignageScore,
  computeTrustScore,
  deriveStatus,
  GEO_DISTANCE_THRESHOLD_METRES,
} from "../config/scoring.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions
//  Called by React Native app when verification starts.
//  Creates a PENDING session and immediately computes geo score.
// ─────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
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
      appVersion,
    } = req.body;

    if (!sessionId || !businessId) {
      return res.status(400).json({ error: "sessionId and businessId are required" });
    }

    if (isRooted === true) {
      return res.status(403).json({
        error  : "DEVICE_COMPROMISED",
        message: "Verification blocked: rooted/jailbroken device detected",
      });
    }

    // Look up registered address for this business
    let registeredCoords  = null;
    let registeredAddress = "";
    const business = await Business.findOne({ businessId });

    if (business) {
      registeredCoords = {
        lat: business.registeredAddress.lat,
        lng: business.registeredAddress.lng,
      };
      registeredAddress = business.registeredAddress.fullText || "";
    } else {
      registeredCoords  = { lat: 12.9716, lng: 77.5946 }; // mock Bengaluru
      registeredAddress = "Mock: Bengaluru, Karnataka";
    }

    // Compute geo score — gpsDistanceMetres now saved (was silently dropped before)
    let geoScore          = 0;
    let gpsDistanceMetres = null;

    if (gpsStart && registeredCoords) {
      gpsDistanceMetres = haversineDistance(gpsStart, registeredCoords);
      geoScore = gpsDistanceMetres <= GEO_DISTANCE_THRESHOLD_METRES ? 1 : 0;
    }

    const session = await Session.create({
      sessionId,
      businessId,
      businessName,
      registeredAddress,
      status           : "PENDING",
      geoScore,
      gpsDistanceMetres,
      meta: {
        device,
        isRooted     : isRooted ?? false,
        gpsStart,
        gpsEnd,
        appVersion,
        accelerometer: accelerometer?.slice(0, 300) ?? [],
      },
      auditLog: [
        {
          action: "SESSION_CREATED",
          detail: `GPS distance: ${gpsDistanceMetres?.toFixed(0) ?? "unknown"}m. Geo score: ${geoScore}`,
        },
      ],
    });

    // If geo fails → flag immediately without waiting for AI
    if (geoScore === 0) {
      await Session.findOneAndUpdate(
        { sessionId },
        {
          status    : "FLAGGED",
          trustScore: 0,
          $push: {
            auditLog: {
              action: "GEO_FAIL_FLAGGED",
              detail: `Distance ${gpsDistanceMetres?.toFixed(0)}m exceeds ${GEO_DISTANCE_THRESHOLD_METRES}m threshold`,
            },
          },
        }
      );

      io.emit("session_flagged_geo", {
        sessionId,
        businessId,
        businessName,
        gpsDistanceMetres,
        status: "FLAGGED",
      });
    }

    res.status(201).json({
      success           : true,
      sessionId         : session.sessionId,
      geoScore,
      gpsDistanceMetres : gpsDistanceMetres ? parseFloat(gpsDistanceMetres.toFixed(1)) : null,
      immediatelyFlagged: geoScore === 0,
    });

  } catch (err) {
    console.error("[POST /sessions]", err);
    if (err.code === 11000) {
      return res.status(409).json({ error: "Session ID already exists" });
    }
    res.status(500).json({ error: "Failed to create session", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions/ai-result
//  Called by AWS Lambda after Rekognition analysis completes.
//  Handles: sign scoring, infra scoring, Layer 1 liveness,
//           Layer 3 screen recording detection.
// ─────────────────────────────────────────────────────────────────
router.post("/ai-result", async (req, res) => {
  try {
    const {
      s3Key,
      textDetected,
      labels,
      infraScore,
      isFlagged       : isFlaggedFromLambda,
      livenessResult,          // Layer 1: "LIVE" | "SUSPICIOUS" | "SPOOF_DETECTED" | "NO_FACE"
      livenessDetail,          // Layer 1: human-readable reason string
      screenRecording,         // Layer 3: { isScreenRecording, confidence, reason }
      sessionId       : sessionIdFromBody,
    } = req.body;

    // ── Resolve sessionId (3 fallback methods) ────────────────────

    let sessionId = null;

    // Method 1: Lambda sends it directly in the body (preferred)
    if (sessionIdFromBody) {
      sessionId = sessionIdFromBody;
    }

    // Method 2: Extract from s3Key → thumbnails/<sessionId>_<timestamp>.<ext>
    if (!sessionId && s3Key) {
      const filename       = s3Key.split("/").pop();
      const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
      const lastUnderscore = nameWithoutExt.lastIndexOf("_");
      // lastIndexOf strips only the trailing timestamp, safe for IDs with underscores
      if (lastUnderscore > 0) {
        sessionId = nameWithoutExt.substring(0, lastUnderscore);
      }
    }

    // Method 3: Still no sessionId — anonymous test mode
    if (!sessionId) {
      console.warn(`[ai-result] Could not extract sessionId from s3Key: ${s3Key}`);

      const infraScoreVal = infraScore || 0;
      // ── SIGN SCORE FIX: use computeSignageScore, not hardcoded 0.2
      const signScore  = computeSignageScore(textDetected, "");
      const geoScore   = 0;
      const isFlagged  = isFlaggedFromLambda ?? false;
      const trustScore = computeTrustScore({ geoScore, signScore, infraScore: infraScoreVal });
      const status     = deriveStatus(trustScore, isFlagged, geoScore);

      return res.json({
        success : true,
        testMode: true,
        message : "No session found — returned computed score only (test mode)",
        trustScore, status, textDetected, labels,
        infraScore: infraScoreVal, signScore, isFlagged,
      });
    }

    const session = await Session.findOne({ sessionId });

    // SessionId resolved but not yet in DB
    if (!session) {
      console.warn(`[ai-result] Session not found in DB: ${sessionId}`);

      const infraScoreVal = infraScore || 0;
      // ── SIGN SCORE FIX: was hardcoded 0.85/0.2 — now uses real scoring
      const signScore  = computeSignageScore(textDetected, "");
      const geoScore   = 0;
      const isFlagged  = isFlaggedFromLambda ?? false;
      const trustScore = computeTrustScore({ geoScore, signScore, infraScore: infraScoreVal });
      const status     = deriveStatus(trustScore, isFlagged, geoScore);

      return res.json({
        success : true,
        testMode: true,
        message : `Session ${sessionId} not in DB — score computed without GPS or business name`,
        trustScore, status, textDetected, labels,
        infraScore: infraScoreVal, signScore, isFlagged,
      });
    }

    // ── Full scoring with real session data ───────────────────────

    // ── SIGN SCORE FIX ────────────────────────────────────────────
    // Old code: signScore = textDetected !== 'NONE' ? 0.85 : 0.20  (flat, no comparison)
    // New code: computeSignageScore does fuzzy word matching against businessName
    //
    //   Score tiers:
    //   1.00 → exact full name in frame
    //   0.85 → all significant brand words matched
    //   0.55–0.70 → primary brand word matched (scales with extra words)
    //   0.30–0.50 → some non-primary words matched
    //   0.25 → text found but no name words matched (random sign)
    //   0.10 → no text detected at all
    const signScore     = computeSignageScore(textDetected, session.businessName);
    const infraScoreVal = infraScore || 0;

    // ── Layer 1: Liveness enforcement ────────────────────────────
    // SPOOF_DETECTED = bright + blurry + flat face (recording a screen)
    // SUSPICIOUS     = 2 of 3 liveness signals present
    const livenessIsFlagged =
      livenessResult === "SPOOF_DETECTED" || livenessResult === "SUSPICIOUS";

    // ── Layer 3: Screen recording enforcement ─────────────────────
    // HIGH   = phone+screen label pair detected
    // MEDIUM = 2+ screen-type labels detected
    // LOW    = single phone label (still flagged)
    const screenIsFlagged = screenRecording?.isScreenRecording === true;

    // Combine all flag sources
    const isFlagged = isFlaggedFromLambda || livenessIsFlagged || screenIsFlagged;

    // ── Zero out video-derived scores if fraud detected ───────────
    // If the video itself can't be trusted, sign and infra evidence
    // is worthless — zeroing prevents a spoofed video from boosting score.
    const effectiveSignScore  = (livenessIsFlagged || screenIsFlagged) ? 0 : signScore;
    const effectiveInfraScore = (livenessIsFlagged || screenIsFlagged) ? 0 : infraScoreVal;

    const trustScore = computeTrustScore({
      geoScore  : session.geoScore,
      signScore : effectiveSignScore,
      infraScore: effectiveInfraScore,
    });

    const status = deriveStatus(trustScore, isFlagged, session.geoScore);

    // ── Build audit log entries ───────────────────────────────────
    const auditEntries = [];

    if (livenessIsFlagged) {
      auditEntries.push({
        action: "LIVENESS_FAIL",
        detail: `Layer 1 — ${livenessResult}: ${livenessDetail ?? ""}`,
      });
    }

    if (screenIsFlagged) {
      auditEntries.push({
        action: "SCREEN_RECORDING_DETECTED",
        detail: `Layer 3 — ${screenRecording.confidence}: ${screenRecording.reason}`,
      });
    }

    auditEntries.push({
      action: "AI_RESULT_RECEIVED",
      detail:
        `Score: ${trustScore} | Status: ${status} | ` +
        `Sign: ${effectiveSignScore.toFixed(2)} | Infra: ${effectiveInfraScore} | ` +
        `Liveness: ${livenessResult ?? "N/A"} | ` +
        `Screen: ${screenIsFlagged ? screenRecording.confidence : "CLEAR"} | ` +
        `Labels: ${labels?.join(", ")}`,
    });

    // ── Persist to DB ─────────────────────────────────────────────
    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          status,
          trustScore,
          signScore : effectiveSignScore,
          infraScore: effectiveInfraScore,
          s3ThumbUri: s3Key,
          aiResults : {
            textDetected,
            labels,
            infraScore    : effectiveInfraScore,
            livenessResult: livenessResult ?? "UNKNOWN",
            livenessDetail: livenessDetail ?? "",
            isFlagged,
            screenRecording: {
              detected  : screenIsFlagged,
              confidence: screenRecording?.confidence ?? null,
              reason    : screenRecording?.reason     ?? null,
            },
          },
        },
        $push: {
          auditLog: { $each: auditEntries },
        },
      },
      { new: true }
    );

    // ── Emit real-time event ──────────────────────────────────────
    io.emit("session_complete", {
      sessionId,
      trustScore,
      status,
      labels         : labels ?? [],
      textDetected,
      infraScore     : effectiveInfraScore,
      signScore      : effectiveSignScore,
      geoScore       : session.geoScore,
      isFlagged,
      livenessResult,
      screenRecording: screenRecording ?? null,
      timestamp      : new Date().toISOString(),
    });

    console.log(
      `[ai-result] ✅ ${sessionId} → Score: ${trustScore} | Status: ${status} | ` +
      `Sign: ${effectiveSignScore.toFixed(2)} | Liveness: ${livenessResult ?? "N/A"} | ` +
      `Screen: ${screenIsFlagged ? "FLAGGED" : "CLEAR"}`
    );

    res.json({
      success      : true,
      sessionId,
      trustScore,
      status,
      signScore    : effectiveSignScore,
      infraScore   : effectiveInfraScore,
      livenessResult,
      screenFlagged: screenIsFlagged,
    });

  } catch (err) {
    console.error("[POST /sessions/ai-result]", err);
    res.status(500).json({ error: "Failed to process AI result", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/sessions
//  List all sessions with optional filtering.
// ─────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      status,
      businessId,
      limit  = 100,
      offset = 0,
      sortBy = "createdAt",
      order  = "desc",
    } = req.query;

    const filter = {};
    if (status)     filter.status     = status;
    if (businessId) filter.businessId = businessId;

    const sessions = await Session.find(filter)
      .sort({ [sortBy]: order === "asc" ? 1 : -1 })
      .skip(Number(offset))
      .limit(Number(limit))
      .select("-auditLog -meta.accelerometer");

    const total = await Session.countDocuments(filter);

    res.json({ data: sessions, total, limit: Number(limit), offset: Number(offset) });

  } catch (err) {
    console.error("[GET /sessions]", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/sessions/:id
//  Single session with full audit trail.
// ─────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) {
      return res.status(404).json({ error: `Session not found: ${req.params.id}` });
    }
    res.json(session);
  } catch (err) {
    console.error("[GET /sessions/:id]", err);
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  PATCH /api/sessions/:id/review
//  Risk officer adds review notes and optionally changes status.
// ─────────────────────────────────────────────────────────────────
router.patch("/:id/review", async (req, res) => {
  try {
    const { notes, reviewedBy, newStatus } = req.body;

    const update = {
      $set: {
        reviewNotes: notes,
        reviewedBy,
        reviewedAt : new Date(),
      },
      $push: {
        auditLog: {
          action: "MANUAL_REVIEW",
          detail: `Reviewed by ${reviewedBy}. Notes: ${notes}. Status → ${newStatus ?? "unchanged"}`,
        },
      },
    };

    // newStatus goes inside $set — mixing top-level keys with $push
    // causes a MongoServerError in MongoDB 5+
    if (newStatus) update.$set.status = newStatus;

    const session = await Session.findOneAndUpdate(
      { sessionId: req.params.id },
      update,
      { new: true }
    );

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    io.emit("session_reviewed", { sessionId: req.params.id, newStatus, reviewedBy });
    res.json({ success: true, session });

  } catch (err) {
    console.error("[PATCH /sessions/:id/review]", err);
    res.status(500).json({ error: "Failed to update review" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  DELETE /api/sessions/:id  (dev/admin only)
// ─────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Delete not allowed in production" });
    }
    await Session.deleteOne({ sessionId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete session" });
  }
});

export default router;