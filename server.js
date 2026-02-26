/**
 * WhatsApp Command Center — Web Server
 *
 * Express server that:
 *   1. Manages the WhatsApp connection (single shared session)
 *   2. Serves static frontend files (public/)
 *   3. Exposes REST API endpoints for WhatsApp actions
 *
 * The frontend talks directly to Supabase for data reads & real-time.
 * This server only handles things that REQUIRE the WhatsApp client:
 *   - QR code generation & auth status
 *   - Sending messages / broadcasting
 *   - Fetching chats, contacts, conversations from WhatsApp
 *   - Backfill & catch-up triggers
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const Store = require('./store');
const WhatsAppClient = require('./whatsapp');
const Analyzer = require('./analyzer');
const AIClassifier = require('./ai-classifier');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const heicConvert = require('heic-convert');

const JWT_SECRET = process.env.JWT_SECRET || 'whatsapp-cc-default-secret-change-me';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── File upload (memory storage for base64 conversion) ──
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// ── HEIC/HEIF → JPEG conversion helper ──
const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];

async function convertMediaIfNeeded(file) {
  const mimeLC = (file.mimetype || '').toLowerCase();
  const extLC = (file.originalname || '').toLowerCase();
  const isHeic = HEIC_TYPES.includes(mimeLC) || extLC.endsWith('.heic') || extLC.endsWith('.heif');

  if (isHeic) {
    console.log(`[Media] Converting HEIC → JPEG: ${file.originalname}`);
    const jpegBuffer = await heicConvert({
      buffer: file.buffer,
      format: 'JPEG',
      quality: 0.85
    });
    const newFilename = file.originalname.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
    return {
      buffer: Buffer.from(jpegBuffer),
      mimetype: 'image/jpeg',
      filename: newFilename
    };
  }

  return {
    buffer: file.buffer,
    mimetype: file.mimetype,
    filename: file.originalname
  };
}

// ── Initialize Store, AI Classifier & WhatsApp ──
const store = new Store();
const aiClassifier = new AIClassifier();
let whatsapp = null;
let qrCode = null;
let connectionStatus = 'disconnected'; // disconnected | qr | loading | ready | failed

async function startWhatsApp() {
  try {
    await store.init();
    console.log('[Server] Store initialized');

    const trackName = await store.getTrackName() || '';
    const analyzer = new Analyzer(trackName);
    whatsapp = new WhatsAppClient(store, analyzer, aiClassifier);

    // Listen for WhatsApp events
    whatsapp.on('qr', (qr) => {
      qrCode = qr;
      connectionStatus = 'qr';
      console.log('[Server] QR code received — scan with WhatsApp');
    });

    whatsapp.on('loading', (percent) => {
      connectionStatus = 'loading';
      qrCode = null;
    });

    whatsapp.on('ready', () => {
      connectionStatus = 'ready';
      qrCode = null;
      console.log('[Server] WhatsApp connected and ready');
    });

    whatsapp.on('auth_failure', (msg) => {
      connectionStatus = 'failed';
      qrCode = null;
      console.error('[Server] WhatsApp auth failure:', msg);
    });

    whatsapp.on('disconnected', (reason) => {
      connectionStatus = 'disconnected';
      qrCode = null;
      console.log('[Server] WhatsApp disconnected:', reason);
    });

    await whatsapp.initialize();
  } catch (err) {
    console.error('[Server] Failed to start WhatsApp:', err.message);
    connectionStatus = 'failed';
  }
}

// ═══════════════════════════════════════════════
// Auth Middleware & Routes
// ═══════════════════════════════════════════════

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ ok: false, error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, trackName } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ ok: false, error: 'Email, password, and name are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    }
    const existing = await store.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'An account with this email already exists' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await store.createUser({ email, passwordHash, name, trackName: trackName || name });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name, track_name: user.track_name, is_admin: user.is_admin } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required' });
    }
    const user = await store.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name, track_name: user.track_name, is_admin: user.is_admin } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await store.getUserById(req.user.id);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const { name, trackName, email, password } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (trackName !== undefined) updates.trackName = trackName;
    if (email !== undefined) updates.email = email;
    if (password) {
      if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
      updates.passwordHash = await bcrypt.hash(password, 10);
    }
    const user = await store.updateUser(req.user.id, updates);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await store.getUsers();
    res.json({ ok: true, users });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
// API Routes
// ═══════════════════════════════════════════════

// ── Connection Status ──

app.get('/api/status', (req, res) => {
  res.json({
    whatsapp: connectionStatus,
    hasQR: !!qrCode,
    uptime: process.uptime()
  });
});

app.get('/api/qr', async (req, res) => {
  if (!qrCode) {
    return res.json({ qr: null, status: connectionStatus });
  }

  // whatsapp.js already converts QR to a data URL image, so pass it through directly
  res.json({ qr: qrCode, status: connectionStatus });
});

app.post('/api/reconnect', async (req, res) => {
  try {
    if (whatsapp) {
      await whatsapp.destroy();
    }
    connectionStatus = 'disconnected';
    qrCode = null;
    await startWhatsApp();
    res.json({ ok: true, message: 'Reconnecting...' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Messaging ──

app.post('/api/send', async (req, res) => {
  if (connectionStatus !== 'ready') {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  try {
    const { chatId, message } = req.body;
    if (!chatId || !message) {
      return res.status(400).json({ ok: false, error: 'chatId and message required' });
    }
    const result = await whatsapp.sendMessage(chatId, message);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/broadcast', async (req, res) => {
  if (connectionStatus !== 'ready') {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  try {
    const { chatIds, message } = req.body;
    if (!chatIds || !chatIds.length || !message) {
      return res.status(400).json({ ok: false, error: 'chatIds array and message required' });
    }
    const results = await whatsapp.sendBroadcast(chatIds, message);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── WhatsApp Data (fetched live from WhatsApp, not from DB) ──

app.get('/api/whatsapp/chats', async (req, res) => {
  if (connectionStatus !== 'ready') {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  try {
    const chats = await whatsapp.getChats();
    res.json({ ok: true, chats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/whatsapp/contacts', async (req, res) => {
  if (connectionStatus !== 'ready') {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  try {
    const contacts = await whatsapp.getContacts();
    res.json({ ok: true, contacts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/whatsapp/conversation/:chatId', async (req, res) => {
  if (connectionStatus !== 'ready') {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = await whatsapp.getConversation(req.params.chatId, limit);
    res.json({ ok: true, messages });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/whatsapp/group/:chatId/participants', async (req, res) => {
  if (connectionStatus !== 'ready') {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  try {
    const participants = await whatsapp.getGroupParticipants(req.params.chatId);
    res.json({ ok: true, participants });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Store Data (convenience endpoints — frontend can also query Supabase directly) ──

app.get('/api/dashboard', async (req, res) => {
  try {
    const stats = await store.getDashboardStats();
    const taskStats = await store.getTaskStats();
    stats.openTasks = taskStats.open + taskStats.inProgress;
    stats.overdueTasks = taskStats.overdue;
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await store.getGroups();
    res.json({ ok: true, groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/questions', async (req, res) => {
  try {
    const unansweredOnly = req.query.status === 'open';
    const questions = await store.getQuestions(unansweredOnly);
    res.json({ ok: true, questions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Question Management (Enhanced v2) ──

app.get('/api/questions/:id/thread', async (req, res) => {
  try {
    const data = await store.getQuestionWithCandidates(req.params.id);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/questions/:id/resolve', async (req, res) => {
  try {
    await store.markQuestionAnswered(req.params.id, req.body.answeredBy);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/questions/:id/dismiss', async (req, res) => {
  try {
    await store.dismissQuestion(req.params.id, req.body.dismissedBy);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/questions/:id/reopen', async (req, res) => {
  try {
    await store.reopenQuestion(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/answers/:id/accept', async (req, res) => {
  try {
    await store.acceptAnswerCandidate(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/mentions', async (req, res) => {
  try {
    const mentions = await store.getMentions();
    res.json({ ok: true, mentions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/dms', async (req, res) => {
  try {
    const dms = await store.getDirectMessages();
    res.json({ ok: true, dms });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Resolve / unresolve mentions
app.post('/api/mentions/:id/resolve', async (req, res) => {
  try {
    const ok = await store.resolveMention(req.params.id, req.body.resolved_by || 'team');
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/mentions/:id/unresolve', async (req, res) => {
  try {
    const ok = await store.unresolvedMention(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Resolve / unresolve DMs
app.post('/api/dms/:id/resolve', async (req, res) => {
  try {
    const ok = await store.resolveDM(req.params.id, req.body.resolved_by || 'team');
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/dms/:id/unresolve', async (req, res) => {
  try {
    const ok = await store.unresolvedDM(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── AI Classification ──

app.get('/api/ai/stats', async (req, res) => {
  try {
    const dbStats = await store.getAIClassificationStats();
    const classifierStats = aiClassifier.getStats();
    res.json({ ok: true, stats: { ...dbStats, classifier: classifierStats } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ai/reclassify', async (req, res) => {
  if (!aiClassifier.enabled) {
    return res.status(400).json({ ok: false, error: 'AI classifier not enabled — set ANTHROPIC_API_KEY in .env' });
  }
  try {
    const limit = parseInt(req.query.limit) || 50;

    // Get unclassified messages
    const messages = await store.getUnclassifiedMessages(limit);
    if (messages.length === 0) {
      return res.json({ ok: true, classified: 0, message: 'No unclassified messages' });
    }

    // Classify in batch
    const results = await aiClassifier.classifyBatch(
      messages.map(m => ({
        body: m.body,
        sender: m.sender,
        chatName: m.chat_name,
        isGroupChat: true
      }))
    );

    let classified = 0;
    let promoted = 0;
    for (let i = 0; i < messages.length; i++) {
      const result = results[i];
      if (!result) continue;

      // Update message classification
      await store.updateMessageAIClassification(messages[i].id, result);
      classified++;

      // If AI detected a question that regex missed, promote it
      if (result.intent === 'question' && result.confidence >= 0.7) {
        await store.promoteMessageToQuestion(messages[i], result);
        promoted++;
      }
    }

    res.json({ ok: true, classified, promoted, total: messages.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ai/classify-one', async (req, res) => {
  if (!aiClassifier.enabled) {
    return res.status(400).json({ ok: false, error: 'AI classifier not enabled' });
  }
  try {
    const { body, sender, chatName } = req.body;
    if (!body) return res.status(400).json({ ok: false, error: 'body required' });

    const result = await aiClassifier.classifyOne(body, { sender, chatName });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Backfill ──

let backfillRunning = false;
let backfillProgress = null;

app.post('/api/backfill', async (req, res) => {
  if (connectionStatus !== 'ready') {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  if (backfillRunning) {
    return res.status(409).json({ ok: false, error: 'Backfill already running', progress: backfillProgress });
  }

  const messagesPerChat = parseInt(req.query.limit) || 100;

  // Start backfill async — respond immediately
  backfillRunning = true;
  backfillProgress = { status: 'running', startedAt: Date.now() };

  res.json({ ok: true, message: `Backfill started (${messagesPerChat} msgs/chat). Check /api/backfill/status for progress.` });

  try {
    const stats = await whatsapp.backfill({
      messagesPerChat,
      onProgress: (update) => {
        backfillProgress = { status: 'running', ...update };
      }
    });
    backfillProgress = { status: 'complete', ...stats, completedAt: Date.now() };
  } catch (err) {
    console.error('[Backfill] Fatal error:', err.message);
    backfillProgress = { status: 'error', error: err.message };
  } finally {
    backfillRunning = false;
  }
});

app.get('/api/backfill/status', (req, res) => {
  res.json({
    ok: true,
    running: backfillRunning,
    progress: backfillProgress
  });
});

app.get('/api/feed', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const feed = await store.getActivityFeed(limit);
    res.json({ ok: true, feed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/volume/hourly', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const data = await store.getHourlyVolume(hours);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/volume/daily', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = await store.getDailyVolume(days);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/senders/top', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const senders = await store.getTopSenders(limit);
    res.json({ ok: true, senders });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Tasks ──

app.get('/api/tasks', async (req, res) => {
  try {
    const { status, assignee, priority, my_day, limit } = req.query;
    const tasks = await store.getTasks({
      status: status || undefined,
      assignee: assignee || undefined,
      priority: priority || undefined,
      myDay: my_day === 'true',
      limit: limit ? parseInt(limit) : undefined
    });
    res.json({ ok: true, tasks });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tasks/stats', async (req, res) => {
  try {
    const stats = await store.getTaskStats();
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const task = await store.getTask(req.params.id);
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
    res.json({ ok: true, task });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, body, chatId, chatName, sender, sourceType, sourceId, priority, assignedTo, dueDate, steps, category } = req.body;
    if (!title) return res.status(400).json({ ok: false, error: 'title required' });

    const id = await store.addTask({
      title, body, chatId, chatName, sender, sourceType, sourceId,
      priority, assignedTo, dueDate, steps, category
    });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const ok = await store.updateTask(req.params.id, req.body);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tasks/:id/complete', async (req, res) => {
  try {
    const ok = await store.completeTask(req.params.id, req.body.completedBy);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tasks/:id/reopen', async (req, res) => {
  try {
    const ok = await store.reopenTask(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const ok = await store.deleteTask(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Approvals ──

app.get('/api/approvals', async (req, res) => {
  try {
    const { status, sender, chat_id, reviewed, limit } = req.query;
    const approvals = await store.getApprovals({
      status: status || undefined,
      sender: sender || undefined,
      chatId: chat_id || undefined,
      reviewed: reviewed !== undefined ? reviewed === 'true' : undefined,
      limit: limit ? parseInt(limit) : undefined
    });
    res.json({ ok: true, approvals });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/approvals/stats', async (req, res) => {
  try {
    const stats = await store.getApprovalStats();
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/approvals/:id', async (req, res) => {
  try {
    const approval = await store.getApproval(req.params.id);
    if (!approval) return res.status(404).json({ ok: false, error: 'Approval not found' });
    res.json({ ok: true, approval });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/approvals/:id', async (req, res) => {
  try {
    const ok = await store.updateApproval(req.params.id, req.body);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/approvals/:id/review', async (req, res) => {
  try {
    const ok = await store.reviewApproval(req.params.id, req.body.reviewedBy);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/approvals/export/csv', async (req, res) => {
  try {
    const { status, sender, chat_id } = req.query;
    const approvals = await store.getApprovals({
      status: status || undefined,
      sender: sender || undefined,
      chatId: chat_id || undefined,
      limit: 10000
    });

    // Build CSV
    const headers = ['ID', 'Date', 'Time', 'Group', 'Sender', 'Status', 'Summary', 'Message', 'Offer Reference', 'Conditions', 'Confidence', 'Reviewed', 'Reviewed By', 'Notes'];
    const rows = approvals.map(a => {
      const d = new Date(a.timestamp);
      return [
        a.id,
        d.toLocaleDateString('en-US'),
        d.toLocaleTimeString('en-US'),
        `"${(a.chat_name || '').replace(/"/g, '""')}"`,
        `"${(a.sender || '').replace(/"/g, '""')}"`,
        a.status,
        `"${(a.ai_summary || '').replace(/"/g, '""')}"`,
        `"${(a.body || '').replace(/"/g, '""')}"`,
        `"${(a.offer_sheet_ref || '').replace(/"/g, '""')}"`,
        `"${(a.conditions || '').replace(/"/g, '""')}"`,
        a.confidence ? a.confidence.toFixed(2) : '0.00',
        a.reviewed ? 'Yes' : 'No',
        a.reviewed_by || '',
        `"${(a.notes || '').replace(/"/g, '""')}"`
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=approvals-${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Settings ──

app.get('/api/settings/partner-groups', async (req, res) => {
  try {
    const groups = await store.getPartnerGroupNames();
    res.json({ ok: true, groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/settings/partner-groups', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    await store.addPartnerGroup(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/settings/partner-groups', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    await store.removePartnerGroup(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/settings/staff', async (req, res) => {
  try {
    const staff = await store.getInternalStaff();
    res.json({ ok: true, staff });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/settings/staff', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    await store.addInternalStaff(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/settings/staff', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    await store.removeInternalStaff(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/settings/group-tracking', async (req, res) => {
  try {
    const { chatId, category, enabled } = req.body;
    if (!chatId) return res.status(400).json({ ok: false, error: 'chatId required' });

    if (category) {
      await store.setGroupCategorySetting(chatId, category, enabled);
    } else {
      // Bulk set all categories
      const settings = req.body.settings || { analytics: true, mentions: true, questions: true };
      await store.setGroupAllSettings(chatId, settings);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/setup/complete', async (req, res) => {
  try {
    const { trackName, partnerGroups, internalStaff } = req.body;

    if (trackName) await store.setTrackName(trackName);
    if (partnerGroups && Array.isArray(partnerGroups)) {
      for (const name of partnerGroups) {
        await store.addPartnerGroup(name);
      }
    }
    if (internalStaff && Array.isArray(internalStaff)) {
      for (const name of internalStaff) {
        await store.addInternalStaff(name);
      }
    }

    await store.completeSetup();
    res.json({ ok: true, message: 'Setup complete' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Media Send ──

app.post('/api/send-media', upload.single('media'), async (req, res) => {
  if (connectionStatus !== 'ready') {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  try {
    const { chatId, caption } = req.body;
    if (!chatId || !req.file) {
      return res.status(400).json({ ok: false, error: 'chatId and media file required' });
    }
    const media = await convertMediaIfNeeded(req.file);
    const base64 = media.buffer.toString('base64');
    const result = await whatsapp.sendMediaMessage(chatId, base64, media.mimetype, media.filename, caption);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/broadcast-media', upload.single('media'), async (req, res) => {
  if (connectionStatus !== 'ready') {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  try {
    let chatIds = req.body.chatIds;
    const caption = req.body.caption;
    if (!chatIds || !req.file) {
      return res.status(400).json({ ok: false, error: 'chatIds and media file required' });
    }
    // chatIds comes as JSON string from FormData
    if (typeof chatIds === 'string') chatIds = JSON.parse(chatIds);
    const media = await convertMediaIfNeeded(req.file);
    const base64 = media.buffer.toString('base64');

    const results = [];
    for (const chatId of chatIds) {
      try {
        await whatsapp.sendMediaMessage(chatId, base64, media.mimetype, media.filename, caption);
        results.push({ chatId, ok: true });
      } catch (err) {
        results.push({ chatId, ok: false, error: err.message });
      }
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Message Templates (stored in Supabase app_settings) ──

app.get('/api/templates', async (req, res) => {
  try {
    const templates = await store._getSetting('message_templates') || [];
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, body } = req.body;
    if (!name || !body) return res.status(400).json({ ok: false, error: 'name and body required' });
    const templates = await store._getSetting('message_templates') || [];
    // Replace if same name exists
    const idx = templates.findIndex(t => t.name === name);
    const template = { name, body, updated: Date.now() };
    if (idx >= 0) templates[idx] = template;
    else templates.push(template);
    await store._setSetting('message_templates', templates);
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/templates', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    let templates = await store._getSetting('message_templates') || [];
    templates = templates.filter(t => t.name !== name);
    await store._setSetting('message_templates', templates);
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Approvals page ──

app.get('/approvals', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'approvals.html'));
});

// ── Team view (no DMs, no mentions, no personal info) ──

app.get('/team', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'team.html'));
});

// ── Catch-all: serve admin frontend ──

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ──

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║  WhatsApp Command Center v3.0 (Web)          ║`);
  console.log(`  ║  Running on http://localhost:${PORT}             ║`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);

  // Start WhatsApp connection after server is listening
  startWhatsApp();
});
