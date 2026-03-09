// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Business Model
//  models/Business.js
// ═══════════════════════════════════════════════════════════════
import mongoose from 'mongoose';

const BusinessSchema = new mongoose.Schema({

  businessId: {
    type    : String,
    required: true,
    unique  : true,
    index   : true,
    trim    : true
  },

  name: {
    type    : String,
    required: true,
    trim    : true
  },

  // Registered address (what GPS is compared against)
  registeredAddress: {
    street  : String,
    city    : String,
    state   : String,
    pincode : String,
    fullText: String,         // human-readable full address
    lat     : { type: Number, required: true },
    lng     : { type: Number, required: true }
  },

  // Type of business
  businessType: {
    type: String,
    enum: ['PROPRIETORSHIP', 'PARTNERSHIP', 'PRIVATE_LIMITED', 'PUBLIC_LIMITED', 'LLP', 'OTHER'],
    default: 'OTHER'
  },

  // Regulatory identifiers
  gstNumber   : { type: String },
  cinNumber   : { type: String },
  panNumber   : { type: String },

  // Verification summary (denormalised for fast dashboard queries)
  totalSessions   : { type: Number, default: 0 },
  lastVerifiedAt  : { type: Date },
  lastTrustScore  : { type: Number },
  overallStatus   : {
    type   : String,
    enum   : ['UNVERIFIED', 'PASSED', 'FLAGGED', 'REVIEW'],
    default: 'UNVERIFIED'
  },

  isActive: { type: Boolean, default: true }

}, {
  timestamps: true
});

export default mongoose.model('Business', BusinessSchema);
