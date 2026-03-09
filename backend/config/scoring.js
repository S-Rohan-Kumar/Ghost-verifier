// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Scoring Engine
//  config/scoring.js
// ═══════════════════════════════════════════════════════════════

// ── Label Score Map ───────────────────────────────────────────────
// Positive signals (office infrastructure)
export const POSITIVE_LABELS = {
  'Desk'       : 0.20,
  'Computer'   : 0.20,
  'Office'     : 0.20,
  'Sign'       : 0.20,
  'Table'      : 0.15,
  'Chair'      : 0.10,
  'Printer'    : 0.10,
  'Monitor'    : 0.15,
  'Keyboard'   : 0.10,
  'Whiteboard' : 0.15,
  'Bookcase'   : 0.10,
  'Shelf'      : 0.10,
  'Filing Cabinet': 0.10,
  'Conference Room': 0.20,
};

// Negative signals (residential — flag immediately)
export const FLAG_LABELS = [
  'Bed', 'Pillow', 'Bedroom', 'Mattress',
  'Couch', 'Sofa', 'Living Room',
  'Refrigerator', 'Oven', 'Kitchen',
  'Bathroom', 'Bathtub', 'Toilet'
];

// ── Weights ───────────────────────────────────────────────────────
export const WEIGHTS = {
  geo    : 0.4,   // G — GPS proximity to registered address
  signage: 0.3,   // S — Business sign text detection
  infra  : 0.3    // I — Office infrastructure labels
};

// ── Thresholds ────────────────────────────────────────────────────
export const GEO_DISTANCE_THRESHOLD_METRES = 100;

export const SCORE_THRESHOLDS = {
  PASSED  : 70,    // score >= 70 → PASSED
  REVIEW  : 40,    // score 40–69 → REVIEW
  FLAGGED : 0      // score < 40  → FLAGGED
};

// ── Signage Score Values ──────────────────────────────────────────
export const SIGNAGE_MATCH_SCORE  = 0.85;   // business name found in image
export const SIGNAGE_PARTIAL_SCORE = 0.50;  // partial match
export const SIGNAGE_NO_MATCH     = 0.20;   // no text or no match

// ═══════════════════════════════════════════════════════════════
//  computeInfraScore(labels: string[]) → { score, flagged }
// ═══════════════════════════════════════════════════════════════
export function computeInfraScore(labels = []) {
  let score = 0;
  let flagged = false;
  const matched = [];
  const flaggedLabels = [];

  labels.forEach(label => {
    if (POSITIVE_LABELS[label]) {
      score += POSITIVE_LABELS[label];
      matched.push(label);
    }
    if (FLAG_LABELS.includes(label)) {
      flagged = true;
      flaggedLabels.push(label);
    }
  });

  return {
    score       : parseFloat(Math.min(score, 1.0).toFixed(2)),
    flagged,
    matched,
    flaggedLabels
  };
}

// ═══════════════════════════════════════════════════════════════
//  computeSignageScore(detectedText, businessName) → number
// ═══════════════════════════════════════════════════════════════
export function computeSignageScore(detectedText = '', businessName = '') {
  if (!detectedText || detectedText === 'NONE') return SIGNAGE_NO_MATCH;

  const detected = detectedText.toLowerCase();
  const name     = businessName.toLowerCase();

  // Full match
  if (detected.includes(name)) return SIGNAGE_MATCH_SCORE;

  // Partial match — check if any word from the business name appears
  const nameWords = name.split(/\s+/).filter(w => w.length > 3);
  const matchCount = nameWords.filter(w => detected.includes(w)).length;

  if (matchCount > 0) {
    return SIGNAGE_PARTIAL_SCORE * (matchCount / nameWords.length);
  }

  return SIGNAGE_NO_MATCH;
}

// ═══════════════════════════════════════════════════════════════
//  computeTrustScore({ G, S, I }) → number (0–100)
// ═══════════════════════════════════════════════════════════════
export function computeTrustScore({ geoScore, signScore, infraScore }) {
  const G = geoScore   ?? 0;
  const S = signScore  ?? 0;
  const I = infraScore ?? 0;
  return Math.round((G * WEIGHTS.geo + S * WEIGHTS.signage + I * WEIGHTS.infra) * 100);
}

// ═══════════════════════════════════════════════════════════════
//  deriveStatus(trustScore, isFlagged, geoScore) → string
// ═══════════════════════════════════════════════════════════════
export function deriveStatus(trustScore, isFlagged, geoScore) {
  // Hard flags override score
  if (isFlagged)    return 'FLAGGED';   // residential label detected
  if (geoScore === 0) return 'FLAGGED'; // GPS mismatch > 100m

  if (trustScore >= SCORE_THRESHOLDS.PASSED) return 'PASSED';
  if (trustScore >= SCORE_THRESHOLDS.REVIEW) return 'REVIEW';
  return 'FLAGGED';
}

// ═══════════════════════════════════════════════════════════════
//  haversineDistance(a, b) → metres
//  a, b: { lat: number, lng: number }
// ═══════════════════════════════════════════════════════════════
export function haversineDistance(a, b) {
  const R    = 6371000; // Earth radius in metres
  const toRad = deg => deg * (Math.PI / 180);

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
    Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
