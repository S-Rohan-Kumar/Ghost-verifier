// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — AWS Lambda
//  index.mjs   (Node.js 20.x)
//
//  Layer 1 — Liveness (DetectFaces quality analysis)
//  Layer 3 — Screen recording (label pair detection)
//
//  FIXES vs previous version:
//  [FIX] DetectText confidence threshold lowered to 70 (was 80 — missed real text)
//  [FIX] DetectLabels now includes Features: ["GENERAL_LABELS"] (required in SDK v3.x
//        for richer label taxonomy; omitting it silently returns fewer labels)
//  [FIX] processingMs field added to result payload (tracks elapsed Lambda time)
//  [FIX] S3 key extension guard — non-image files (.json, .txt, etc.) now rejected
//        early before any Rekognition call, preventing InvalidImageException crashes
//  [FIX] screenRecording payload omits null fields when no detection found
//  [FIX] All existing fixes from prior version retained (per-call try/catch, etc.)
// ═══════════════════════════════════════════════════════════════
import {
  RekognitionClient,
  DetectTextCommand,
  DetectLabelsCommand,
  DetectFacesCommand,
} from "@aws-sdk/client-rekognition";

const rek = new RekognitionClient({ region: process.env.AWS_REGION || "ap-south-1" });

// Allowed image extensions — Rekognition only supports these formats
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

// ── Infra scoring labels ─────────────────────────────────────────
const POSITIVE_LABELS = {
  Desk              : 0.20,
  Table             : 0.15,
  Chair             : 0.10,
  Bookcase          : 0.10,
  "Filing Cabinet"  : 0.10,
  Whiteboard        : 0.15,
  Computer          : 0.20,
  Monitor           : 0.15,
  Keyboard          : 0.10,
  Mouse             : 0.10,
  Printer           : 0.10,
  Laptop            : 0.20,
  Pc                : 0.15,
  Screen            : 0.10,
  Electronics       : 0.10,
  "Computer Hardware": 0.15,
  Office            : 0.20,
  "Conference Room" : 0.20,
  "Office Building" : 0.20,
  Sign              : 0.20,
  Indoors           : 0.05,
};

// ── Residential flag labels ──────────────────────────────────────
const FLAG_LABELS = [
  "Bed", "Pillow", "Bedroom", "Mattress",
  "Couch", "Sofa", "Living Room",
  "Refrigerator", "Oven", "Kitchen",
  "Bathroom", "Bathtub", "Toilet",
];

// ── Layer 3: Screen recording indicator labels ───────────────────
const SCREEN_LABELS = [
  "Screen", "Display",
  "Mobile Phone", "Cell Phone", "Phone",
  "Tablet", "iPad",
  "Television", "TV",
];

const SCREEN_PAIR_FLAGS = [
  ["Phone",        "Screen"],
  ["Phone",        "Monitor"],
  ["Phone",        "Display"],
  ["Tablet",       "Screen"],
  ["Laptop",       "Screen"],
  ["Phone",        "Television"],
  ["Mobile Phone", "Screen"],
  ["Mobile Phone", "Monitor"],
  ["Cell Phone",   "Screen"],
];

// ── Layer 3: Detect screen recording from labels ─────────────────
function detectScreenRecording(labels) {
  if (!labels || labels.length === 0) {
    return { isScreenRecording: false };
  }

  const labelSet = new Set(labels);

  for (const [a, b] of SCREEN_PAIR_FLAGS) {
    if (labelSet.has(a) && labelSet.has(b)) {
      return {
        isScreenRecording: true,
        confidence       : "HIGH",
        reason           : `Suspicious pair detected: "${a}" + "${b}" in same frame`,
      };
    }
  }

  const found = labels.filter(l => SCREEN_LABELS.includes(l));
  if (found.length >= 2) {
    return {
      isScreenRecording: true,
      confidence       : "MEDIUM",
      reason           : `Multiple screen objects detected: ${found.join(", ")}`,
    };
  }

  if (labelSet.has("Mobile Phone") || labelSet.has("Cell Phone")) {
    return {
      isScreenRecording: true,
      confidence       : "LOW",
      reason           : "Mobile phone visible in frame — possible screen recording",
    };
  }

  return { isScreenRecording: false };
}

// ── Layer 1: Face quality → liveness signal ──────────────────────
function analyseFaceQuality(faceDetails) {
  if (!faceDetails || faceDetails.length === 0) {
    return {
      livenessResult: "NO_FACE",
      livenessDetail: "No face detected — scoring proceeds without liveness check",
    };
  }

  const face       = faceDetails[0];
  const quality    = face.Quality || {};
  const brightness = quality.Brightness ?? 50;
  const sharpness  = quality.Sharpness  ?? 50;
  const pose       = face.Pose || {};
  const pitchAbs   = Math.abs(pose.Pitch ?? 10);
  const yawAbs     = Math.abs(pose.Yaw   ?? 10);

  console.log(
    `[Layer 1] brightness=${brightness.toFixed(1)} sharpness=${sharpness.toFixed(1)} ` +
    `pitch=${pose.Pitch?.toFixed(1) ?? "n/a"} yaw=${pose.Yaw?.toFixed(1) ?? "n/a"}`
  );

  const tooBright = brightness > 88;
  const tooBlurry = sharpness  < 25;
  const flatPose  = pitchAbs   < 2 && yawAbs < 2;

  if (tooBright && tooBlurry && flatPose) {
    return {
      livenessResult: "SPOOF_DETECTED",
      livenessDetail: `Screen spoof: brightness=${brightness.toFixed(0)} (>88), sharpness=${sharpness.toFixed(0)} (<25), face pose flat`,
    };
  }

  if (tooBright && tooBlurry) {
    return {
      livenessResult: "SUSPICIOUS",
      livenessDetail: `Abnormal quality: brightness=${brightness.toFixed(0)} sharpness=${sharpness.toFixed(0)}`,
    };
  }

  if (tooBright && flatPose) {
    return {
      livenessResult: "SUSPICIOUS",
      livenessDetail: `Bright screen + flat pose: brightness=${brightness.toFixed(0)}, pitch=${pose.Pitch?.toFixed(1)} yaw=${pose.Yaw?.toFixed(1)}`,
    };
  }

  return {
    livenessResult: "LIVE",
    livenessDetail : `Quality OK — brightness=${brightness.toFixed(0)}, sharpness=${sharpness.toFixed(0)}`,
  };
}

// ── Main handler ─────────────────────────────────────────────────
export const handler = async (event) => {
  const startMs = Date.now();
  console.log("Lambda triggered. Event:", JSON.stringify(event, null, 2));

  try {
    // ── 1. Parse S3 event ────────────────────────────────────────
    if (!event.Records || !event.Records[0]) {
      console.error("No Records in event");
      return { statusCode: 400, body: "No S3 records in event" };
    }

    const bucket = event.Records[0].s3.bucket.name;
    const key    = decodeURIComponent(
      event.Records[0].s3.object.key.replace(/\+/g, " ")
    );

    console.log(`Processing: s3://${bucket}/${key}`);

    // ── 2. Guard: reject non-image files early ───────────────────
    // Rekognition throws InvalidImageException on non-image S3 objects.
    // Catching it per-call is expensive — better to reject up front.
    const ext = key.split(".").pop().toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      console.warn(`Skipping non-image file: ${key} (extension: .${ext})`);
      return { statusCode: 200, body: `Skipped non-image file: ${key}` };
    }

    // ── 3. Extract sessionId from filename ───────────────────────
    // Format: thumbnails/<sessionId>_<timestamp>.<ext>
    const filename       = key.split("/").pop();
    const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
    const lastUnderscore = nameWithoutExt.lastIndexOf("_");
    const sessionId =
      lastUnderscore > 0 && /^\d+$/.test(nameWithoutExt.substring(lastUnderscore + 1))
        ? nameWithoutExt.substring(0, lastUnderscore)
        : nameWithoutExt;

    console.log(`sessionId: "${sessionId}" | filename: "${filename}"`);

    const s3Image = { S3Object: { Bucket: bucket, Name: key } };

    // ── 4. Run Rekognition calls (each individually try/caught) ──

    // -- DetectText --
    // FIX: Confidence threshold lowered from 80 to 70.
    // Real-world office photos often return text at 70-79 confidence.
    // The previous threshold of >80 silently dropped valid text detections.
    console.log("Starting Rekognition DetectText...");
    let textRes = null;
    try {
      textRes = await rek.send(new DetectTextCommand({ Image: s3Image }));
      console.log(`DetectText: ${textRes.TextDetections?.length ?? 0} detections`);
    } catch (textErr) {
      console.error("DetectText failed:", textErr.message);
    }

    // -- DetectLabels --
    // FIX: Added Features: ["GENERAL_LABELS"].
    // In AWS SDK v3 (Rekognition API 2023+), omitting Features causes the API
    // to return a reduced label set — office objects like "Monitor", "Keyboard",
    // "Filing Cabinet" are frequently absent without this flag.
    console.log("Starting Rekognition DetectLabels...");
    let labelRes = null;
    try {
      labelRes = await rek.send(new DetectLabelsCommand({
        Image         : s3Image,
        MaxLabels     : 30,
        MinConfidence : 60,
        Features      : ["GENERAL_LABELS"],
      }));
      console.log(`DetectLabels: ${labelRes.Labels?.length ?? 0} labels`);
    } catch (labelErr) {
      console.error("DetectLabels failed:", labelErr.message);
    }

    // -- DetectFaces --
    console.log("Starting Rekognition DetectFaces (Layer 1)...");
    let faceRes = null;
    try {
      faceRes = await rek.send(new DetectFacesCommand({
        Image     : s3Image,
        Attributes: ["ALL"],
      }));
      console.log(`DetectFaces: ${faceRes.FaceDetails?.length ?? 0} faces`);
    } catch (faceErr) {
      // Normal for office-only shots — not a hard error
      console.warn("DetectFaces failed (no face in frame is normal):", faceErr.message);
    }

    // ── 5. Process text ──────────────────────────────────────────
    // FIX: Confidence threshold changed from > 80 to >= 70
    const textDetected =
      (textRes?.TextDetections ?? [])
        .filter(t => t.Type === "LINE" && t.Confidence >= 70)
        .map(t => t.DetectedText)
        .join(", ") || "NONE";

    console.log(`Text detected: "${textDetected}"`);

    // ── 6. Process labels ────────────────────────────────────────
    const labels = (labelRes?.Labels ?? []).map(l => l.Name);
    console.log(`Labels: ${labels.join(", ") || "none"}`);

    // ── 7. Compute infra score ───────────────────────────────────
    let infraScore = 0;
    let isFlagged  = false;

    for (const label of labels) {
      if (POSITIVE_LABELS[label]) {
        infraScore += POSITIVE_LABELS[label];
        console.log(`  + ${label}: +${POSITIVE_LABELS[label]} => running total: ${infraScore.toFixed(2)}`);
      }
      if (FLAG_LABELS.includes(label)) {
        isFlagged = true;
        console.warn(`  Residential label detected: ${label}`);
      }
    }

    infraScore = parseFloat(Math.min(infraScore, 1.0).toFixed(2));
    console.log(`infraScore: ${infraScore} | isFlagged: ${isFlagged}`);

    // ── 8. Layer 3 — Screen recording detection ──────────────────
    const screenCheck = detectScreenRecording(labels);
    if (screenCheck.isScreenRecording) {
      isFlagged = true;
      console.warn(`[Layer 3] ${screenCheck.confidence}: ${screenCheck.reason}`);
    } else {
      console.log("[Layer 3] CLEAR — no screen recording indicators");
    }

    // ── 9. Layer 1 — Liveness detection ─────────────────────────
    const { livenessResult, livenessDetail } = analyseFaceQuality(faceRes?.FaceDetails);
    console.log(`[Layer 1] ${livenessResult}: ${livenessDetail}`);

    if (livenessResult === "SPOOF_DETECTED" || livenessResult === "SUSPICIOUS") {
      isFlagged = true;
    }

    // ── 10. Build result payload ─────────────────────────────────
    // FIX: screenRecording omits null fields when no detection found.
    // Previously always sent { isScreenRecording, confidence: null, reason: null }
    // which caused downstream consumers to trip on null checks unnecessarily.
    const screenRecordingPayload = screenCheck.isScreenRecording
      ? {
          isScreenRecording: true,
          confidence       : screenCheck.confidence,
          reason           : screenCheck.reason,
        }
      : { isScreenRecording: false };

    // FIX: processingMs added so CloudWatch and downstream can track Lambda duration.
    const processingMs = Date.now() - startMs;

    const result = {
      sessionId,
      s3Key          : key,
      textDetected,
      labels,
      infraScore,
      isFlagged,
      livenessResult,
      livenessDetail,
      screenRecording: screenRecordingPayload,
      processingMs,
      timestamp      : new Date().toISOString(),
    };

    console.log("Final result:", JSON.stringify(result, null, 2));

    // ── 11. POST to backend ──────────────────────────────────────
    const BACKEND_URL = process.env.BACKEND_URL;
    if (!BACKEND_URL) {
      console.error("BACKEND_URL environment variable not set!");
      return { statusCode: 500, body: "BACKEND_URL not configured" };
    }

    console.log(`POSTing to: ${BACKEND_URL}/api/sessions/ai-result`);

    let response;
    try {
      response = await fetch(`${BACKEND_URL}/api/sessions/ai-result`, {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify(result),
      });
    } catch (fetchErr) {
      console.error("fetch to backend failed:", fetchErr.message);
      return {
        statusCode: 200,
        body: JSON.stringify({ result, backendError: fetchErr.message }),
      };
    }

    const responseText = await response.text();
    console.log(`Backend response: ${response.status} — ${responseText}`);

    if (!response.ok) {
      console.error(`Backend returned ${response.status}: ${responseText}`);
      return { statusCode: 500, body: `Backend error: ${response.status} - ${responseText}` };
    }

    console.log("Lambda complete");
    return {
      statusCode: 200,
      body: JSON.stringify({
        result,
        backendResponse: JSON.parse(responseText),
      }),
    };

  } catch (err) {
    console.error("Lambda uncaught error:", err.message);
    console.error(err.stack);
    return { statusCode: 500, body: err.message };
  }
};