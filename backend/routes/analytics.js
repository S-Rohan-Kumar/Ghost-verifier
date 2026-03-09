// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Analytics Routes
//  routes/analytics.js
// ═══════════════════════════════════════════════════════════════
import express from 'express';
import Session from '../models/Session.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
//  GET /api/analytics/summary
//  Overall stats for the dashboard header cards.
// ─────────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const [total, passed, flagged, review, pending] = await Promise.all([
      Session.countDocuments({}),
      Session.countDocuments({ status: 'PASSED' }),
      Session.countDocuments({ status: 'FLAGGED' }),
      Session.countDocuments({ status: 'REVIEW' }),
      Session.countDocuments({ status: { $in: ['PENDING', 'PROCESSING'] } })
    ]);

    // Average trust score (only completed sessions)
    const avgResult = await Session.aggregate([
      { $match: { trustScore: { $ne: null } } },
      { $group: { _id: null, avgScore: { $avg: '$trustScore' } } }
    ]);
    const avgScore = avgResult[0] ? Math.round(avgResult[0].avgScore) : 0;

    // Sessions in last 24 hours
    const last24h = await Session.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });

    res.json({
      total, passed, flagged, review, pending,
      avgScore, last24h,
      flaggedRate: total > 0 ? parseFloat(((flagged / total) * 100).toFixed(1)) : 0
    });

  } catch (err) {
    console.error('[GET /analytics/summary]', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/analytics/trend
//  Sessions per day for the last 7 days (line/bar chart data).
// ─────────────────────────────────────────────────────────────────
router.get('/trend', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const trend = await Session.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: {
            year : { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day  : { $dayOfMonth: '$createdAt' }
          },
          total  : { $sum: 1 },
          flagged: { $sum: { $cond: [{ $eq: ['$status', 'FLAGGED'] }, 1, 0] } },
          passed : { $sum: { $cond: [{ $eq: ['$status', 'PASSED']  }, 1, 0] } },
          avgScore: { $avg: '$trustScore' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    // Format as simple array
    const data = trend.map(t => ({
      date    : `${t._id.year}-${String(t._id.month).padStart(2,'0')}-${String(t._id.day).padStart(2,'0')}`,
      total   : t.total,
      flagged : t.flagged,
      passed  : t.passed,
      avgScore: Math.round(t.avgScore || 0)
    }));

    res.json(data);

  } catch (err) {
    console.error('[GET /analytics/trend]', err);
    res.status(500).json({ error: 'Failed to fetch trend data' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/analytics/hotspots
//  GPS coordinates for heatmap. Returns all sessions with GPS data.
//  Includes cluster detection for fraud hotspots.
// ─────────────────────────────────────────────────────────────────
router.get('/hotspots', async (req, res) => {
  try {
    const { status } = req.query; // optional filter

    const filter = { 'meta.gpsStart': { $exists: true } };
    if (status) filter.status = status;

    const sessions = await Session
      .find(filter)
      .select('sessionId businessId businessName status trustScore meta.gpsStart createdAt')
      .sort({ createdAt: -1 })
      .limit(500);

    const points = sessions.map(s => ({
      sessionId   : s.sessionId,
      businessId  : s.businessId,
      businessName: s.businessName,
      status      : s.status,
      trustScore  : s.trustScore,
      lat         : s.meta.gpsStart.lat,
      lng         : s.meta.gpsStart.lng,
      timestamp   : s.createdAt
    }));

    // Simple cluster detection: group flagged points within ~200m of each other
    const flaggedPoints = points.filter(p => p.status === 'FLAGGED');
    const clusters = detectClusters(flaggedPoints, 200); // 200m radius

    res.json({ points, clusters, total: points.length });

  } catch (err) {
    console.error('[GET /analytics/hotspots]', err);
    res.status(500).json({ error: 'Failed to fetch hotspot data' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/analytics/score-distribution
//  Histogram data: how many sessions fall in each score range.
// ─────────────────────────────────────────────────────────────────
router.get('/score-distribution', async (req, res) => {
  try {
    const buckets = await Session.aggregate([
      { $match: { trustScore: { $ne: null } } },
      {
        $bucket: {
          groupBy   : '$trustScore',
          boundaries: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 101],
          default   : 'other',
          output    : { count: { $sum: 1 } }
        }
      }
    ]);

    const distribution = buckets.map(b => ({
      range: b._id === 'other' ? '100' : `${b._id}–${b._id + 9}`,
      count: b.count
    }));

    res.json(distribution);

  } catch (err) {
    console.error('[GET /analytics/score-distribution]', err);
    res.status(500).json({ error: 'Failed to fetch score distribution' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  Helper: detect GPS clusters within a radius
// ─────────────────────────────────────────────────────────────────
function detectClusters(points, radiusMetres) {
  const clusters = [];
  const used = new Set();

  points.forEach((p, i) => {
    if (used.has(i)) return;

    const nearby = points.filter((q, j) => {
      if (j === i || used.has(j)) return false;
      const dist = haversine({ lat: p.lat, lng: p.lng }, { lat: q.lat, lng: q.lng });
      return dist <= radiusMetres;
    });

    if (nearby.length >= 2) { // 3+ sessions (p + 2 nearby) = hotspot
      const cluster = [p, ...nearby];
      cluster.forEach((_, j) => used.add(points.indexOf(cluster[j])));
      clusters.push({
        centre      : { lat: p.lat, lng: p.lng },
        count       : cluster.length,
        sessions    : cluster.map(c => c.sessionId),
        businesses  : [...new Set(cluster.map(c => c.businessName))],
        radiusMetres: radiusMetres
      });
    }
  });

  return clusters;
}

function haversine(a, b) {
  const R = 6371000, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
}

export default router;