// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Database Seed Script
//  seed.js
//
//  Run: node seed.js
//  Seeds 25 sessions + 10 businesses into MongoDB.
//  First 7 sessions are FLAGGED (demo purposes).
// ═══════════════════════════════════════════════════════════════
import mongoose from 'mongoose';
import dotenv   from 'dotenv';
import Session  from './models/Session.js';
import Business from './models/Business.js';
dotenv.config();

// ── Mock Businesses ───────────────────────────────────────────────
const BUSINESSES = [
  {
    businessId: 'GST27AAACR5055K1Z5',
    name: 'Global Tech Solutions Pvt Ltd',
    gstNumber: 'GST27AAACR5055K1Z5',
    businessType: 'PRIVATE_LIMITED',
    registeredAddress: {
      street: '14th Floor, Prestige Tower, MG Road',
      city: 'Bengaluru', state: 'Karnataka', pincode: '560001',
      fullText: '14th Floor, Prestige Tower, MG Road, Bengaluru 560001',
      lat: 12.9752, lng: 77.6077
    }
  },
  {
    businessId: 'GST27AADCS1682G1ZJ',
    name: 'Sunrise Exports Pvt Ltd',
    gstNumber: 'GST27AADCS1682G1ZJ',
    businessType: 'PRIVATE_LIMITED',
    registeredAddress: {
      street: 'Plot 22, MIDC Industrial Area, Andheri East',
      city: 'Mumbai', state: 'Maharashtra', pincode: '400093',
      fullText: 'Plot 22, MIDC Industrial Area, Andheri East, Mumbai 400093',
      lat: 19.1136, lng: 72.8697
    }
  },
  {
    businessId: 'GST07AABCT1332L1ZR',
    name: 'Metro Traders Association',
    gstNumber: 'GST07AABCT1332L1ZR',
    businessType: 'PARTNERSHIP',
    registeredAddress: {
      street: 'Shop 4, Nehru Place Market',
      city: 'New Delhi', state: 'Delhi', pincode: '110019',
      fullText: 'Shop 4, Nehru Place Market, New Delhi 110019',
      lat: 28.5494, lng: 77.2510
    }
  },
  {
    businessId: 'GST36AABCI4402B1ZL',
    name: 'Infinity Consulting LLP',
    gstNumber: 'GST36AABCI4402B1ZL',
    businessType: 'LLP',
    registeredAddress: {
      street: 'Level 3, Cyber Towers, Hitech City',
      city: 'Hyderabad', state: 'Telangana', pincode: '500081',
      fullText: 'Level 3, Cyber Towers, Hitech City, Hyderabad 500081',
      lat: 17.4435, lng: 78.3772
    }
  },
  {
    businessId: 'GST33AADCP4593M1ZB',
    name: 'Peak Solutions Ltd',
    gstNumber: 'GST33AADCP4593M1ZB',
    businessType: 'PUBLIC_LIMITED',
    registeredAddress: {
      street: 'Old No 16, New No 32, Anna Salai',
      city: 'Chennai', state: 'Tamil Nadu', pincode: '600002',
      fullText: 'Old No 16 New No 32, Anna Salai, Chennai 600002',
      lat: 13.0604, lng: 80.2496
    }
  },
  {
    businessId: 'GST27AADCU7305R1ZP',
    name: 'Urban Finance Corp',
    gstNumber: 'GST27AADCU7305R1ZP',
    businessType: 'PRIVATE_LIMITED',
    registeredAddress: {
      street: '8th Floor, One BKC, Bandra Kurla Complex',
      city: 'Mumbai', state: 'Maharashtra', pincode: '400051',
      fullText: '8th Floor, One BKC, Bandra Kurla Complex, Mumbai 400051',
      lat: 19.0653, lng: 72.8683
    }
  },
  // Ghost businesses (will produce FLAGGED sessions)
  {
    businessId: 'GST29AABCN1234P1ZG',
    name: 'NextGen Ventures (Ghost)',
    gstNumber: 'GST29AABCN1234P1ZG',
    businessType: 'PROPRIETORSHIP',
    registeredAddress: {
      street: '901, Diamond District, HAL Old Airport Road',
      city: 'Bengaluru', state: 'Karnataka', pincode: '560008',
      fullText: '901, Diamond District, HAL Old Airport Road, Bengaluru 560008',
      lat: 12.9592, lng: 77.6484
    }
  },
  {
    businessId: 'GST27AABCA5555P1ZS',
    name: 'Apex Holdings (Ghost)',
    gstNumber: 'GST27AABCA5555P1ZS',
    businessType: 'PROPRIETORSHIP',
    registeredAddress: {
      street: 'Unit 7B, Nirlon Compound, Off Western Express Highway',
      city: 'Mumbai', state: 'Maharashtra', pincode: '400063',
      fullText: 'Unit 7B, Nirlon Compound, Off Western Express Highway, Mumbai 400063',
      lat: 19.1627, lng: 72.8476
    }
  }
];

// ── Mock Sessions Data ────────────────────────────────────────────
function makeSessions() {
  const sessions = [];

  // ── 7 FLAGGED sessions (ghost businesses / residential) ─────────
  const flaggedData = [
    { biz: BUSINESSES[6], city: 'Bengaluru', offset: { lat: 0.05, lng: 0.06 },
      labels: ['Bed', 'Pillow', 'Bedroom', 'Couch'], text: 'NONE', device: 'Samsung Galaxy S23' },
    { biz: BUSINESSES[7], city: 'Mumbai', offset: { lat: 0.08, lng: 0.07 },
      labels: ['Sofa', 'Television', 'Living Room'], text: 'NONE', device: 'iPhone 14' },
    { biz: BUSINESSES[6], city: 'Bengaluru', offset: { lat: 0.051, lng: 0.061 },
      labels: ['Bed', 'Refrigerator', 'Kitchen'], text: 'NONE', device: 'OnePlus 11' },
    { biz: BUSINESSES[7], city: 'Mumbai', offset: { lat: 0.079, lng: 0.071 },
      labels: ['Mattress', 'Pillow', 'Wardrobe'], text: 'NONE', device: 'Pixel 7' },
    { biz: BUSINESSES[0], city: 'Bengaluru', offset: { lat: 0.15, lng: 0.14 }, // GPS far away
      labels: ['Desk', 'Computer'], text: 'Global Tech Solutions', device: 'iPhone 15' },
    { biz: BUSINESSES[1], city: 'Mumbai', offset: { lat: 0.12, lng: 0.11 },    // GPS far away
      labels: ['Table', 'Chair'], text: 'Sunrise Exports', device: 'Samsung S24' },
    { biz: BUSINESSES[6], city: 'Bengaluru', offset: { lat: 0.052, lng: 0.062 },
      labels: ['Bed', 'Bathroom', 'Toilet'], text: 'NONE', device: 'Redmi Note 12' },
  ];

  flaggedData.forEach((d, i) => {
    const geoScore = i >= 4 ? 0 : 1; // last 2 flagged by GPS
    const infraI   = geoScore === 0 ? 0.3 : 0.1;
    const signS    = d.text !== 'NONE' ? 0.85 : 0.2;
    const trust    = Math.round((geoScore * 0.4 + signS * 0.3 + infraI * 0.3) * 100);

    sessions.push({
      sessionId   : `sess_flagged_${i}_${Date.now() + i}`,
      businessId  : d.biz.businessId,
      businessName: d.biz.name,
      status      : 'FLAGGED',
      trustScore  : trust,
      geoScore,
      signScore   : signS,
      infraScore  : infraI,
      gpsDistanceMetres: geoScore === 0 ? 14500 + i * 200 : 85,
      s3ThumbUri  : `thumbnails/sess_flagged_${i}_demo.jpg`,
      s3VideoUri  : `videos/sess_flagged_${i}_demo.mp4`,
      aiResults: {
        textDetected: d.text,
        labels      : d.labels,
        infraScore  : infraI,
        livenessResult: 'LIVE',
        isFlagged   : true
      },
      meta: {
        device  : d.device,
        isRooted: false,
        gpsStart: {
          lat: d.biz.registeredAddress.lat + d.offset.lat,
          lng: d.biz.registeredAddress.lng + d.offset.lng
        },
        gpsEnd: {
          lat: d.biz.registeredAddress.lat + d.offset.lat + 0.001,
          lng: d.biz.registeredAddress.lng + d.offset.lng + 0.001
        }
      },
      createdAt: new Date(Date.now() - (i + 1) * 3600000 * 2)
    });
  });

  // ── 18 PASSED / REVIEW sessions (real businesses) ───────────────
  const passedData = [
    { biz: BUSINESSES[0], labels: ['Desk', 'Computer', 'Monitor', 'Chair', 'Whiteboard'], text: 'Global Tech Solutions', device: 'iPhone 15 Pro' },
    { biz: BUSINESSES[1], labels: ['Table', 'Computer', 'Printer', 'Chair'],              text: 'Sunrise Exports',        device: 'Samsung Galaxy S24' },
    { biz: BUSINESSES[2], labels: ['Desk', 'Chair', 'Sign', 'Computer'],                  text: 'Metro Traders',          device: 'iPhone 14' },
    { biz: BUSINESSES[3], labels: ['Computer', 'Desk', 'Whiteboard', 'Office'],           text: 'Infinity Consulting',    device: 'Pixel 8' },
    { biz: BUSINESSES[4], labels: ['Desk', 'Chair', 'Printer', 'Sign'],                   text: 'Peak Solutions',         device: 'OnePlus 12' },
    { biz: BUSINESSES[5], labels: ['Computer', 'Monitor', 'Desk', 'Chair'],               text: 'Urban Finance Corp',     device: 'iPhone 15' },
    { biz: BUSINESSES[0], labels: ['Desk', 'Computer', 'Filing Cabinet'],                 text: 'Global Tech Solutions', device: 'Samsung S23' },
    { biz: BUSINESSES[1], labels: ['Table', 'Chair', 'Whiteboard'],                       text: 'Sunrise Exports',        device: 'Redmi Note 13 Pro' },
    { biz: BUSINESSES[2], labels: ['Desk', 'Computer'],                                   text: 'Metro Traders Association', device: 'iPhone 14 Pro' },
    { biz: BUSINESSES[3], labels: ['Office', 'Computer', 'Desk'],                         text: 'Infinity Consulting LLP', device: 'Pixel 7a' },
    { biz: BUSINESSES[4], labels: ['Chair', 'Table'],                                     text: 'NONE', device: 'OnePlus 11' },         // REVIEW
    { biz: BUSINESSES[5], labels: ['Desk'],                                               text: 'NONE', device: 'Samsung A54' },        // REVIEW
    { biz: BUSINESSES[0], labels: ['Computer', 'Monitor', 'Keyboard', 'Desk', 'Sign'],    text: 'Global Tech Solutions', device: 'iPhone 15 Plus' },
    { biz: BUSINESSES[1], labels: ['Desk', 'Chair', 'Computer', 'Printer', 'Bookcase'],   text: 'Sunrise Exports Pvt',   device: 'Samsung Galaxy S24 Ultra' },
    { biz: BUSINESSES[2], labels: ['Table', 'Whiteboard', 'Office'],                      text: 'Metro Traders',          device: 'iPhone 13' },
    { biz: BUSINESSES[3], labels: ['Desk', 'Conference Room', 'Whiteboard'],              text: 'Infinity Consulting',    device: 'Pixel 6' },
    { biz: BUSINESSES[4], labels: ['Desk', 'Computer', 'Chair', 'Sign'],                  text: 'Peak Solutions Ltd',     device: 'OnePlus 10 Pro' },
    { biz: BUSINESSES[5], labels: ['Computer', 'Desk', 'Filing Cabinet', 'Office'],       text: 'Urban Finance',          device: 'iPhone 12' },
  ];

  passedData.forEach((d, i) => {
    const geoScore  = 1;
    const signS     = computeSignScore(d.text, d.biz.name);
    const infraI    = computeInfra(d.labels);
    const trust     = Math.round((geoScore * 0.4 + signS * 0.3 + infraI * 0.3) * 100);
    const status    = trust >= 70 ? 'PASSED' : 'REVIEW';

    sessions.push({
      sessionId   : `sess_real_${i}_${Date.now() + i + 100}`,
      businessId  : d.biz.businessId,
      businessName: d.biz.name,
      status,
      trustScore  : trust,
      geoScore,
      signScore   : signS,
      infraScore  : infraI,
      gpsDistanceMetres: 20 + Math.random() * 60,
      s3ThumbUri  : `thumbnails/sess_real_${i}_demo.jpg`,
      s3VideoUri  : `videos/sess_real_${i}_demo.mp4`,
      aiResults: {
        textDetected: d.text,
        labels      : d.labels,
        infraScore  : infraI,
        livenessResult: 'LIVE',
        isFlagged   : false
      },
      meta: {
        device  : d.device,
        isRooted: false,
        gpsStart: {
          lat: d.biz.registeredAddress.lat + (Math.random() - 0.5) * 0.001,
          lng: d.biz.registeredAddress.lng + (Math.random() - 0.5) * 0.001
        },
        gpsEnd: {
          lat: d.biz.registeredAddress.lat + (Math.random() - 0.5) * 0.0005,
          lng: d.biz.registeredAddress.lng + (Math.random() - 0.5) * 0.0005
        }
      },
      createdAt: new Date(Date.now() - (i + 8) * 3600000 * 1.5)
    });
  });

  return sessions;
}

// helpers for seed
const SCORE_MAP = { Desk:0.2, Computer:0.2, Table:0.15, Chair:0.1, Monitor:0.15,
                    Printer:0.1, Office:0.2, Sign:0.2, Whiteboard:0.15, Bookcase:0.1,
                    'Conference Room':0.2, Keyboard:0.1, 'Filing Cabinet':0.1 };

function computeInfra(labels) {
  return parseFloat(Math.min(labels.reduce((a, l) => a + (SCORE_MAP[l] || 0), 0), 1.0).toFixed(2));
}

function computeSignScore(text, bizName) {
  if (!text || text === 'NONE') return 0.20;
  if (text.toLowerCase().includes(bizName.toLowerCase().split(' ')[0])) return 0.85;
  return 0.50;
}

// ── Main ──────────────────────────────────────────────────────────
async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Clear existing data
    await Session.deleteMany({});
    await Business.deleteMany({});
    console.log('Cleared existing data');

    // Insert businesses
    await Business.insertMany(BUSINESSES);
    console.log(`Inserted ${BUSINESSES.length} businesses`);

    // Insert sessions
    const sessions = makeSessions();
    await Session.insertMany(sessions);
    console.log(`Inserted ${sessions.length} sessions`);

    // Print summary
    const flagged = sessions.filter(s => s.status === 'FLAGGED').length;
    const passed  = sessions.filter(s => s.status === 'PASSED').length;
    const review  = sessions.filter(s => s.status === 'REVIEW').length;
    console.log(`\n✅ Seed complete:`);
    console.log(`   Total sessions : ${sessions.length}`);
    console.log(`   PASSED         : ${passed}`);
    console.log(`   REVIEW         : ${review}`);
    console.log(`   FLAGGED        : ${flagged}`);
    console.log(`   Businesses     : ${BUSINESSES.length}\n`);

  } catch (err) {
    console.error('Seed failed:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seed();
