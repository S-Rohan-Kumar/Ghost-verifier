// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — COMPLETE & FIXED Sessions Routes
//  routes/sessions.js
// ═══════════════════════════════════════════════════════════════
import express from "express";
import Session from "../models/Session.js";
import Business from "../models/Business.js";
import { io } from "../index.js";
import {
  haversineDistance,
  computeInfraScore,
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

    // Validate required fields
    if (!sessionId || !businessId) {
      return res
        .status(400)
        .json({ error: "sessionId and businessId are required" });
    }

    // Block rooted devices immediately
    if (isRooted === true) {
      return res.status(403).json({
        error: "DEVICE_COMPROMISED",
        message: "Verification blocked: rooted/jailbroken device detected",
      });
    }

    // Look up registered address for this business
    let registeredCoords = null;
    let registeredAddress = "";
    
    // FIX: Look up official Business data to ensure Signage Score works correctly
    const business = await Business.findOne({ businessId });

    if (business) {
      registeredCoords = {
        lat: business.registeredAddress.lat,
        lng: business.registeredAddress.lng,
      };
      registeredAddress = business.registeredAddress.fullText || "";
    } else {
      // For hackathon: use a mock registered address if business not found
      registeredCoords = { lat: 12.9716, lng: 77.5946 }; // mock Bengaluru
      registeredAddress = "Mock: Bengaluru, Karnataka";
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
      // FIX: Prioritize official name from DB over the one sent by the app
      businessName: business ? business.name : businessName,
      registeredAddress,
      status: "PENDING",
      geoScore,
      gpsDistanceMetres,
      meta: {
        device,
        isRooted: isRooted ?? false,
        gpsStart,
        gpsEnd,
        accelerometer: accelerometer?.slice(0, 300) ?? [], // cap at 300 samples
        appVersion,
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
          status: "FLAGGED",
          trustScore: 0,
          $push: {
            auditLog: {
              action: "GEO_FAIL_FLAGGED",
              detail: `Distance ${gpsDistanceMetres?.toFixed(0)}m exceeds 100m threshold`,
            },
          },
        },
      );
      // Emit early flag to dashboard
      io.emit("session_flagged_geo", {
        sessionId,
        businessId,
        businessName: business ? business.name : businessName,
        gpsDistanceMetres,
        status: "FLAGGED",
      });
    }

    res.status(201).json({
      success: true,
      sessionId: session.sessionId,
      geoScore,
      gpsDistanceMetres: gpsDistanceMetres
        ? parseFloat(gpsDistanceMetres.toFixed(1))
        : null,
      immediatelyFlagged: geoScore === 0,
    });
  } catch (err) {
    console.error("[POST /sessions]", err);
    if (err.code === 11000) {
      return res.status(409).json({ error: "Session ID already exists" });
    }
    res
      .status(500)
      .json({ error: "Failed to create session", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/sessions/ai-result
//  Called by AWS Lambda after Rekognition analysis completes.
// ─────────────────────────────────────────────────────────────────
router.post("/ai-result", async (req, res) => {
  try {
    const {
      s3Key,
      textDetected,
      labels,
      infraScore,
      isFlagged,
      livenessResult,
      sessionId: sessionIdFromBody, 
    } = req.body;

    let sessionId = null;

    // Method 1: Lambda sends it directly in body (FIX: This is now the primary method)
    if (sessionIdFromBody) {
      sessionId = sessionIdFromBody;
    }

    // Method 2: Extract from s3Key
    if (!sessionId && s3Key) {
      const filename = s3Key.split("/").pop();
      const nameWithoutExt = filename.split(".")[0];
      const parts = nameWithoutExt.split("_");
      if (parts.length >= 3) {
        sessionId = parts.slice(0, -1).join("_");
      }
    }

    // Method 3: Fallback/Test mode logic remains intact for your testing
    if (!sessionId) {
      console.warn(`[ai-result] Could not extract sessionId from s3Key: ${s3Key}`);
      const infraScoreVal = infraScore || 0;
      const trustScore = Math.round((0 * 0.4 + 0.2 * 0.3 + infraScoreVal * 0.3) * 100);
      const status = trustScore >= 70 ? "PASSED" : trustScore >= 40 ? "REVIEW" : "FLAGGED";

      return res.json({
        success: true,
        testMode: true,
        message: "No session found — returned computed score only",
        trustScore,
        status,
        textDetected,
        labels,
      });
    }

    const session = await Session.findOne({ sessionId });

    if (!session) {
      console.warn(`[ai-result] Session not found in DB: ${sessionId}`);
      return res.status(404).json({ error: "Session record not found" });
    }

    // FIX: Clean detected text to remove commas for better fuzzy matching
    const cleanedText = textDetected ? textDetected.replace(/,/g, ' ') : "NONE";
    const signScore = computeSignageScore(cleanedText, session.businessName);
    const infraScoreVal = infraScore || 0;

    const trustScore = computeTrustScore({
      geoScore: session.geoScore,
      signScore,
      infraScore: infraScoreVal,
    });

    const status = deriveStatus(trustScore, isFlagged, session.geoScore);

    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          status,
          trustScore,
          signScore,
          infraScore: infraScoreVal,
          s3ThumbUri: s3Key,
          aiResults: {
            textDetected: cleanedText,
            labels,
            infraScore: infraScoreVal,
            livenessResult: livenessResult ?? "UNKNOWN",
            isFlagged,
          },
        },
        $push: {
          auditLog: {
            action: "AI_RESULT_RECEIVED",
            detail: `Score: ${trustScore} | Status: ${status} | Labels: ${labels?.join(", ")}`,
          },
        },
      },
      { new: true },
    );

    io.emit("session_complete", {
      sessionId,
      trustScore,
      status,
      labels: labels ?? [],
      textDetected: cleanedText,
      infraScore: infraScoreVal,
      signScore,
      geoScore: session.geoScore,
      isFlagged,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, sessionId, trustScore, status });
  } catch (err) {
    console.error("[POST /sessions/ai-result]", err);
    res.status(500).json({ error: "Failed to process AI result" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/sessions (RESTORED LIST VIEW)
// ─────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { status, businessId, limit = 100, offset = 0, sortBy = "createdAt", order = "desc" } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (businessId) filter.businessId = businessId;

    const sessions = await Session.find(filter)
      .sort({ [sortBy]: order === "asc" ? 1 : -1 })
      .skip(Number(offset))
      .limit(Number(limit))
      .select("-auditLog -meta.accelerometer");

    const total = await Session.countDocuments(filter);
    res.json({ data: sessions, total, limit: Number(limit), offset: Number(offset) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/sessions/:id (RESTORED DETAIL VIEW)
// ─────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  PATCH /api/sessions/:id/review (RESTORED REVIEW LOGIC)
// ─────────────────────────────────────────────────────────────────
router.patch("/:id/review", async (req, res) => {
  try {
    const { notes, reviewedBy, newStatus } = req.body;
    const update = {
      reviewNotes: notes,
      reviewedBy,
      reviewedAt: new Date(),
      $push: {
        auditLog: {
          action: "MANUAL_REVIEW",
          detail: `Reviewed by ${reviewedBy}. Notes: ${notes}. Status: ${newStatus ?? "unchanged"}`,
        },
      },
    };
    if (newStatus) update.status = newStatus;

    const session = await Session.findOneAndUpdate({ sessionId: req.params.id }, update, { new: true });
    if (!session) return res.status(404).json({ error: "Session not found" });

    io.emit("session_reviewed", { sessionId: req.params.id, newStatus, reviewedBy });
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: "Failed to update review" });
  }
});

// ─────────────────────────────────────────────────────────────────
//  DELETE /api/sessions/:id (RESTORED DELETE)
// ─────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    if (process.env.NODE_ENV === "production") return res.status(403).json({ error: "Action not allowed" });
    await Session.deleteOne({ sessionId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;