// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Session Model
//  models/Session.js
// ═══════════════════════════════════════════════════════════════
import mongoose from "mongoose";

const AuditEntrySchema = new mongoose.Schema(
  {
    action   : { type: String, required: true },
    detail   : { type: String, default: "" },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const SessionSchema = new mongoose.Schema(
  {
    sessionId        : { type: String, required: true, unique: true, index: true },
    businessId       : { type: String, required: true, index: true },
    businessName     : { type: String },
    registeredAddress: { type: String, default: "" },

    status: {
      type   : String,
      enum   : ["PENDING", "PASSED", "FLAGGED", "REVIEW", "ERROR"],
      default: "PENDING",
      index  : true,
    },

    // ── Scores ────────────────────────────────────────────────────
    trustScore       : { type: Number, default: null },
    geoScore         : { type: Number, default: null },
    signScore        : { type: Number, default: null },
    infraScore       : { type: Number, default: null },
    gpsDistanceMetres: { type: Number, default: null },

    // ── S3 assets ─────────────────────────────────────────────────
    s3VideoUri: { type: String },
    s3ThumbUri: { type: String },

    // ── AI results (raw + processed) ─────────────────────────────
    aiResults: {
      textDetected  : { type: String },
      labels        : [String],
      infraScore    : { type: Number },

      // Layer 1 — Liveness
      livenessResult: { type: String, enum: ["LIVE", "SUSPICIOUS", "SPOOF_DETECTED", "NO_FACE", "UNKNOWN"], default: "UNKNOWN" },
      livenessDetail: { type: String, default: "" },

      // Layer 3 — Screen recording
      screenRecording: {
        detected  : { type: Boolean, default: false },
        confidence: { type: String, enum: ["HIGH", "MEDIUM", "LOW", null], default: null },
        reason    : { type: String, default: null },
      },

      isFlagged: { type: Boolean },
    },

    // ── Device / GPS ──────────────────────────────────────────────
    meta: {
      device      : String,
      isRooted    : { type: Boolean, default: false },
      gpsStart    : { lat: Number, lng: Number },
      gpsEnd      : { lat: Number, lng: Number },
      appVersion  : String,
      accelerometer: [{ x: Number, y: Number, z: Number, t: Number }],
    },

    // ── Manual review ─────────────────────────────────────────────
    reviewNotes: { type: String },
    reviewedBy : { type: String },
    reviewedAt : { type: Date },

    // ── Audit trail ───────────────────────────────────────────────
    auditLog: { type: [AuditEntrySchema], default: [] },
  },
  {
    timestamps: true, // adds createdAt + updatedAt
  }
);

export default mongoose.model("Session", SessionSchema);