// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Backend Entry Point
//  index.js
// ═══════════════════════════════════════════════════════════════
import express    from 'express';
import http       from 'http';
import { Server } from 'socket.io';
import mongoose   from 'mongoose';
import cors       from 'cors';
import dotenv     from 'dotenv';

// Load environment variables first
dotenv.config();

// ── Route Imports ────────────────────────────────────────────────
import sessionRoutes    from './routes/sessions.js';
import uploadRoutes     from './routes/upload.js';
import businessRoutes   from './routes/businesses.js';
import analyticsRoutes  from './routes/analytics.js';

// ── App Setup ────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Socket.io Setup ──────────────────────────────────────────────
export const io = new Server(server, {
  cors: {
    origin : '*',       // allow all origins for hackathon
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[Socket.io] Client disconnected: ${socket.id}`);
  });
});

// ── Middleware ───────────────────────────────────────────────────
app.use(cors({ origin: '*' }));           // allow all for hackathon
app.use(express.json({ limit: '10mb' })); // parse JSON bodies
app.use(express.urlencoded({ extended: true }));

// ── Routes ───────────────────────────────────────────────────────
app.use('/api/sessions',   sessionRoutes);
app.use('/api/upload',     uploadRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/analytics',  analyticsRoutes);

// ── Health Check ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'Ghost Business Verifier API',
    status : 'running',
    version: '2.0.0',
    time   : new Date().toISOString()
  });
});

// ── MongoDB Connection ───────────────────────────────────────────
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('[MongoDB] Connected successfully');
  } catch (err) {
    console.error('[MongoDB] Connection failed:', err.message);
    // Retry after 5 seconds (helpful on Railway cold starts)
    setTimeout(connectDB, 5000);
  }
};

// ── Global Error Handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.stack);
  res.status(500).json({
    error  : 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// ── Start Server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚀 Ghost Verifier Backend running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/`);
    console.log(`   Sessions API: http://localhost:${PORT}/api/sessions\n`);
  });
});
