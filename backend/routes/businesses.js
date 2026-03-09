// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Businesses Routes
//  routes/businesses.js
// ═══════════════════════════════════════════════════════════════
import express  from 'express';
import Business from '../models/Business.js';
import Session  from '../models/Session.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
//  GET /api/businesses
//  List all businesses with their latest verification status.
// ─────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, city, limit = 50, offset = 0 } = req.query;

    const filter = { isActive: true };
    if (status) filter.overallStatus = status;

    const businesses = await Business
      .find(filter)
      .sort({ lastVerifiedAt: -1 })
      .skip(Number(offset))
      .limit(Number(limit));

    const total = await Business.countDocuments(filter);

    res.json({ data: businesses, total });

  } catch (err) {
    console.error('[GET /businesses]', err);
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/businesses/:id
//  Single business with all their verification sessions.
// ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const business = await Business.findOne({ businessId: req.params.id });
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Fetch their sessions
    const sessions = await Session
      .find({ businessId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('-auditLog -meta.accelerometer');

    res.json({ business, sessions });

  } catch (err) {
    console.error('[GET /businesses/:id]', err);
    res.status(500).json({ error: 'Failed to fetch business' });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/businesses
//  Register a new business (admin only in production).
// ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      businessId, name, gstNumber, cinNumber, panNumber,
      businessType, registeredAddress
    } = req.body;

    const business = await Business.create({
      businessId, name, gstNumber, cinNumber, panNumber,
      businessType, registeredAddress
    });

    res.status(201).json({ success: true, business });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Business ID already exists' });
    }
    console.error('[POST /businesses]', err);
    res.status(500).json({ error: 'Failed to create business' });
  }
});

export default router;
