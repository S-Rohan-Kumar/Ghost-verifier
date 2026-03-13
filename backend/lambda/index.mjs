// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — AWS Lambda  (Layer 1 + Layer 3)
//  index.mjs
//
//  Layer 1 — Liveness Detection via DetectFaces quality analysis
//  Layer 3 — Screen / Recording Detection via label analysis
// ═══════════════════════════════════════════════════════════════
import {
  RekognitionClient,
  DetectTextCommand,
  DetectLabelsCommand,
  DetectFacesCommand,
} from "@aws-sdk/client-rekognition";

const rek = new RekognitionClient({ region: "ap-south-1" });

// ── Infra scoring labels ──────────────────────────────────────
const POSITIVE_LABELS = {
  Desk             : 0.20,
  Computer         : 0.20,
  Office           : 0.20,
  Sign             : 0.20,
  Table            : 0.15,
  Monitor          : 0.15,
  Whiteboard       : 0.15,
  Chair            : 0.10,
  Printer          : 0.10,
  Keyboard         : 0.10,
  Bookcase         : 0.10,
  "Filing Cabinet" : 0.10,
  "Conference Room": 0.20,
};

const FLAG_LABELS = [
  "Bed", "Pillow", "Bedroom", "Mattress",
  "Couch", "Sofa", "Living Room",
  "Refrigerator", "Oven", "Kitchen",
  "Bathroom", "Bathtub", "Toilet",
];

// ── Layer 3: Screen recording indicator labels ────────────────
// If Rekognition sees these objects the person is likely filming
// another device showing a pre-recorded video of the business.
const SCREEN_LABELS = [
  "Screen", "Display",
  "Mobile Phone", "Cell Phone", "Phone",
  "Tablet", "iPad", "Laptop",
  "Television", "TV",
];

// Seeing BOTH of these together in one frame = very high confidence fraud
const SCREEN_PAIR_FLAGS = [
  ["Phone",   "Screen"],
  ["Phone",   "Monitor"],
  ["Phone",   "Display"],
  ["Tablet",  "Screen"],
  ["Laptop",  "Screen"],
  ["Phone",   "Television"],
];

function detectScreenRecording(labels) {
  const labelSet = new Set(labels);

  // High confidence: suspicious pair
  for (const [a, b] of SCREEN_PAIR_FLAGS) {
    if (labelSet.has(a) && labelSet.has(b)) {
      return {
        isScreenRecording: true,
        confidence       : "HIGH",
        reason           : `Suspicious pair detected: "${a}" + "${b}" in same frame`,
      };
    }
  }

  // Medium confidence: 2+ screen-type labels
  const found = labels.filter(l => SCREEN_LABELS.includes(l));
  if (found.length >= 2) {
    return {
      isScreenRecording: true,
      confidence       : "MEDIUM",
      reason           : `Multiple screen objects: ${found.join(", ")}`,
    };
  }

  // Low confidence: lone phone label
  if (labelSet.has("Mobile Phone") || labelSet.has("Cell Phone")) {
    return {
      isScreenRecording: true,
      confidence       : "LOW",
      reason           : "Mobile phone visible in frame — possible screen recording",
    };
  }

  return { isScreenRecording: false, confidence: null, reason: null };
}

// ── Layer 1: Face quality → liveness signal ───────────────────
// A face displayed on a phone screen has:
//   HIGH brightness  (screen backlight)
//   LOW  sharpness   (moiré/pixel-grid interference when re-photographed)
//   FLAT pose        (2D screen = near-zero natural head tilt)
//
// A real person's face has normal brightness, decent sharpness,
// and slight natural head movement.
function analyseFaceQuality(faceDetails) {
  if (!faceDetails || faceDetails.length === 0) {
    return {
      livenessResult: "NO_FACE",
      livenessDetail: "No face detected in frame",
    };
  }

  const face       = faceDetails[0];
  const quality    = face.Quality || {};
  const brightness = quality.Brightness ?? 50;
  const sharpness  = quality.Sharpness  ?? 50;
  const pose       = face.Pose || {};
  const pitchAbs   = Math.abs(pose.Pitch ?? 0);
  const yawAbs     = Math.abs(pose.Yaw   ?? 0);

  console.log(
    `[liveness] brightness=${brightness.toFixed(1)} sharpness=${sharpness.toFixed(1)} ` +
    `pitch=${pose.Pitch?.toFixed(1)} yaw=${pose.Yaw?.toFixed(1)}`
  );

  const tooBright   = brightness > 88;   // screens glow
  const tooBlurry   = sharpness  < 25;   // moiré pattern reduces sharpness
  const flatPose    = pitchAbs   < 2 && yawAbs < 2; // 2D screen has no natural tilt

  // All 3 signals → high confidence spoof
  if (tooBright && tooBlurry && flatPose) {
    return {
      livenessResult: "SPOOF_DETECTED",
      livenessDetail:
        `Screen recording likely: brightness=${brightness.toFixed(0)} (too high), ` +
        `sharpness=${sharpness.toFixed(0)} (too low), face pose is flat`,
    };
  }

  // 2 signals → suspicious
  if (tooBright && tooBlurry) {
    return {
      livenessResult: "SUSPICIOUS",
      livenessDetail:
        `Abnormal quality: brightness=${brightness.toFixed(0)}, sharpness=${sharpness.toFixed(0)}`,
    };
  }

  if (tooBright && flatPose) {
    return {
      livenessResult: "SUSPICIOUS",
      livenessDetail:
        `Bright + flat pose: brightness=${brightness.toFixed(0)}, pitch=${pose.Pitch?.toFixed(1)}, yaw=${pose.Yaw?.toFixed(1)}`,
    };
  }

  // Real live person
  return {
    livenessResult: "LIVE",
    livenessDetail:
      `Quality OK — brightness=${brightness.toFixed(0)}, sharpness=${sharpness.toFixed(0)}`,
  };
}

// ── Main handler ──────────────────────────────────────────────
export const handler = async (event) => {
  try {
    // 1. Parse S3 event
    const bucket = event.Records[0].s3.bucket.name;
    const key    = decodeURIComponent(
      event.Records[0].s3.object.key.replace(/\+/g, " ")
    );
    console.log(`Processing: s3://${bucket}/${key}`);

    // Extract sessionId: thumbnails/<sessionId>_<timestamp>.<ext>
    const filename       = key.split("/").pop();
    const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
    const lastUnderscore = nameWithoutExt.lastIndexOf("_");
    const sessionId =
      lastUnderscore > 0 && /^\d+$/.test(nameWithoutExt.substring(lastUnderscore + 1))
        ? nameWithoutExt.substring(0, lastUnderscore)
        : nameWithoutExt;

    console.log(`sessionId: ${sessionId}`);

    const s3Image = { S3Object: { Bucket: bucket, Name: key } };

    // 2. Run all 3 Rekognition calls in parallel
    const [textRes, labelRes, faceRes] = await Promise.all([
      rek.send(new DetectTextCommand({ Image: s3Image })),
      rek.send(new DetectLabelsCommand({ Image: s3Image, MaxLabels: 20, MinConfidence: 65 })),
      // Layer 1: ALL attributes gives us Quality (Brightness + Sharpness) and Pose
      rek.send(new DetectFacesCommand({ Image: s3Image, Attributes: ["ALL"] })),
    ]);

    // 3. Text
    const textDetected =
      textRes.TextDetections
        .filter(t => t.Type === "LINE" && t.Confidence > 80)
        .map(t => t.DetectedText)
        .join(", ") || "NONE";

    // 4. Labels
    const labels = labelRes.Labels.map(l => l.Name);

    // 5. Infra score
    let infraScore = 0;
    let isFlagged  = false;
    labels.forEach(label => {
      if (POSITIVE_LABELS[label]) infraScore += POSITIVE_LABELS[label];
      if (FLAG_LABELS.includes(label)) isFlagged = true;
    });
    infraScore = parseFloat(Math.min(infraScore, 1.0).toFixed(2));

    // 6. Layer 3 — screen recording detection
    const screenCheck = detectScreenRecording(labels);
    if (screenCheck.isScreenRecording) {
      isFlagged = true;
      console.warn(`[Layer 3] ${screenCheck.confidence}: ${screenCheck.reason}`);
    }

    // 7. Layer 1 — liveness detection
    const { livenessResult, livenessDetail } = analyseFaceQuality(faceRes.FaceDetails);
    console.log(`[Layer 1] ${livenessResult}: ${livenessDetail}`);
    if (livenessResult === "SPOOF_DETECTED" || livenessResult === "SUSPICIOUS") {
      isFlagged = true;
    }

    // 8. Build result payload
    const result = {
      sessionId,
      s3Key          : key,
      textDetected,
      labels,
      infraScore,
      isFlagged,
      livenessResult,                  // LIVE | SUSPICIOUS | SPOOF_DETECTED | NO_FACE
      livenessDetail,                  // human-readable explanation
      screenRecording: screenCheck,    // { isScreenRecording, confidence, reason }
      timestamp      : new Date().toISOString(),
    };

    console.log("Result:", JSON.stringify(result, null, 2));

    // 9. POST to backend
    const BACKEND_URL = process.env.BACKEND_URL;
    if (!BACKEND_URL) {
      console.error("❌ BACKEND_URL not set");
      return { statusCode: 500, body: "BACKEND_URL not configured" };
    }

    const response = await fetch(`${BACKEND_URL}/api/sessions/ai-result`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(result),
    });

    const responseText = await response.text();
    console.log(`Backend: ${response.status} — ${responseText}`);

    if (!response.ok) {
      return { statusCode: 500, body: `Backend error: ${response.status} - ${responseText}` };
    }

    console.log("✅ Done");
    return {
      statusCode: 200,
      body      : JSON.stringify({ result, backendResponse: JSON.parse(responseText) }),
    };

  } catch (err) {
    console.error("Lambda error:", err.message, err.stack);
    return { statusCode: 500, body: err.message };
  }
};
