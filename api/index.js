/**
 * WhatsApp Command Center — Vercel Serverless API
 *
 * This is the Vercel-compatible version of the server.
 * It includes ONLY the data endpoints (Supabase reads/writes).
 * WhatsApp-specific routes (QR, send, backfill) are NOT included —
 * those require a persistent WhatsApp client running locally or on Railway.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const Store = require('../store');
const AIClassifier = require('../ai-classifier');

const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Initialize Store & AI ──
let store = null;
let aiClassifier = null;

async function getStore() {
  if (!store) {
    store = new Store();
    await store.init();
  }
  return store;
}

function getAI() {
  if (!aiClassifier) {
    aiClassifier = new AIClassifier();
  }
  return aiClassifier;
}

// ═══════════════════════════════════════════════
// API Routes (Data only — no WhatsApp client needed)
// ═══════════════════════════════════════════════

// ── Connection Status (returns dashboard-only mode) ──

app.get('/api/status', (req, res) => {
  res.json({
    whatsapp: 'cloud',
    hasQR: false,
    uptime: 0,
    mode: 'dashboard-only',
    message: 'Dashboard hosted on Vercel. WhatsApp client runs separately.'
  });
});

// ── Dashboard ──

app.get('/api/dashboard', async (req, res) => {
  try {
    const s = await getStore();
    const stats = await s.getDashboardStats();
    const taskStats = await s.getTaskStats();
    stats.openTasks = taskStats.open + taskStats.inProgress;
    stats.overdueTasks = taskStats.overdue;
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Groups ──

app.get('/api/groups', async (req, res) => {
  try {
    const s = await getStore();
    const groups = await s.getGroups();
    res.json({ ok: true, groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Questions ──

app.get('/api/questions', async (req, res) => {
  try {
    const s = await getStore();
    const unansweredOnly = req.query.status === 'open';
    const questions = await s.getQuestions(unansweredOnly);
    res.json({ ok: true, questions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/questions/:id/thread', async (req, res) => {
  try {
    const s = await getStore();
    const data = await s.getQuestionWithCandidates(req.params.id);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/questions/:id/resolve', async (req, res) => {
  try {
    const s = await getStore();
    await s.markQuestionAnswered(req.params.id, req.body.answeredBy);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/questions/:id/dismiss', async (req, res) => {
  try {
    const s = await getStore();
    await s.dismissQuestion(req.params.id, req.body.dismissedBy);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/questions/:id/reopen', async (req, res) => {
  try {
    const s = await getStore();
    await s.reopenQuestion(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/answers/:id/accept', async (req, res) => {
  try {
    const s = await getStore();
    await s.acceptAnswerCandidate(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Mentions ──

app.get('/api/mentions', async (req, res) => {
  try {
    const s = await getStore();
    const mentions = await s.getMentions();
    res.json({ ok: true, mentions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/mentions/:id/resolve', async (req, res) => {
  try {
    const s = await getStore();
    const ok = await s.resolveMention(req.params.id, req.body.resolved_by || 'team');
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/mentions/:id/unresolve', async (req, res) => {
  try {
    const s = await getStore();
    const ok = await s.unresolvedMention(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DMs ──

app.get('/api/dms', async (req, res) => {
  try {
    const s = await getStore();
    const dms = await s.getDirectMessages();
    res.json({ ok: true, dms });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/dms/:id/resolve', async (req, res) => {
  try {
    const s = await getStore();
    const ok = await s.resolveDM(req.params.id, req.body.resolved_by || 'team');
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/dms/:id/unresolve', async (req, res) => {
  try {
    const s = await getStore();
    const ok = await s.unresolvedDM(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Activity Feed ──

app.get('/api/feed', async (req, res) => {
  try {
    const s = await getStore();
    const limit = parseInt(req.query.limit) || 50;
    const feed = await s.getActivityFeed(limit);
    res.json({ ok: true, feed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Volume / Analytics ──

app.get('/api/volume/hourly', async (req, res) => {
  try {
    const s = await getStore();
    const hours = parseInt(req.query.hours) || 24;
    const data = await s.getHourlyVolume(hours);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/volume/daily', async (req, res) => {
  try {
    const s = await getStore();
    const days = parseInt(req.query.days) || 7;
    const data = await s.getDailyVolume(days);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/senders/top', async (req, res) => {
  try {
    const s = await getStore();
    const limit = parseInt(req.query.limit) || 10;
    const senders = await s.getTopSenders(limit);
    res.json({ ok: true, senders });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Tasks ──

app.get('/api/tasks', async (req, res) => {
  try {
    const s = await getStore();
    const { status, assignee, priority, my_day, limit } = req.query;
    const tasks = await s.getTasks({
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
    const s = await getStore();
    const stats = await s.getTaskStats();
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const s = await getStore();
    const task = await s.getTask(req.params.id);
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
    res.json({ ok: true, task });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const s = await getStore();
    const { title, body, chatId, chatName, sender, sourceType, sourceId, priority, assignedTo, dueDate, steps, category } = req.body;
    if (!title) return res.status(400).json({ ok: false, error: 'title required' });
    const id = await s.addTask({
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
    const s = await getStore();
    const ok = await s.updateTask(req.params.id, req.body);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tasks/:id/complete', async (req, res) => {
  try {
    const s = await getStore();
    const ok = await s.completeTask(req.params.id, req.body.completedBy);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tasks/:id/reopen', async (req, res) => {
  try {
    const s = await getStore();
    const ok = await s.reopenTask(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const s = await getStore();
    const ok = await s.deleteTask(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── AI Classification ──

app.get('/api/ai/stats', async (req, res) => {
  try {
    const s = await getStore();
    const ai = getAI();
    const dbStats = await s.getAIClassificationStats();
    const classifierStats = ai.getStats();
    res.json({ ok: true, stats: { ...dbStats, classifier: classifierStats } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ai/reclassify', async (req, res) => {
  const ai = getAI();
  if (!ai.enabled) {
    return res.status(400).json({ ok: false, error: 'AI classifier not enabled — set ANTHROPIC_API_KEY' });
  }
  try {
    const s = await getStore();
    const limit = parseInt(req.query.limit) || 50;
    const messages = await s.getUnclassifiedMessages(limit);
    if (messages.length === 0) {
      return res.json({ ok: true, classified: 0, message: 'No unclassified messages' });
    }
    const results = await ai.classifyBatch(
      messages.map(m => ({
        body: m.body, sender: m.sender, chatName: m.chat_name, isGroupChat: true
      }))
    );
    let classified = 0, promoted = 0;
    for (let i = 0; i < messages.length; i++) {
      const result = results[i];
      if (!result) continue;
      await s.updateMessageAIClassification(messages[i].id, result);
      classified++;
      if (result.intent === 'question' && result.confidence >= 0.7) {
        await s.promoteMessageToQuestion(messages[i], result);
        promoted++;
      }
    }
    res.json({ ok: true, classified, promoted, total: messages.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Settings ──

app.get('/api/settings/partner-groups', async (req, res) => {
  try {
    const s = await getStore();
    const groups = await s.getPartnerGroupNames();
    res.json({ ok: true, groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/settings/partner-groups', async (req, res) => {
  try {
    const s = await getStore();
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    await s.addPartnerGroup(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/settings/partner-groups', async (req, res) => {
  try {
    const s = await getStore();
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    await s.removePartnerGroup(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/settings/staff', async (req, res) => {
  try {
    const s = await getStore();
    const staff = await s.getInternalStaff();
    res.json({ ok: true, staff });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/settings/staff', async (req, res) => {
  try {
    const s = await getStore();
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    await s.addInternalStaff(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/settings/staff', async (req, res) => {
  try {
    const s = await getStore();
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    await s.removeInternalStaff(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/settings/group-tracking', async (req, res) => {
  try {
    const s = await getStore();
    const { chatId, category, enabled } = req.body;
    if (!chatId) return res.status(400).json({ ok: false, error: 'chatId required' });
    if (category) {
      await s.setGroupCategorySetting(chatId, category, enabled);
    } else {
      const settings = req.body.settings || { analytics: true, mentions: true, questions: true };
      await s.setGroupAllSettings(chatId, settings);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/setup/complete', async (req, res) => {
  try {
    const s = await getStore();
    const { trackName, partnerGroups, internalStaff } = req.body;
    if (trackName) await s.setTrackName(trackName);
    if (partnerGroups && Array.isArray(partnerGroups)) {
      for (const name of partnerGroups) await s.addPartnerGroup(name);
    }
    if (internalStaff && Array.isArray(internalStaff)) {
      for (const name of internalStaff) await s.addInternalStaff(name);
    }
    await s.completeSetup();
    res.json({ ok: true, message: 'Setup complete' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Templates ──

app.get('/api/templates', async (req, res) => {
  try {
    const s = await getStore();
    const templates = await s._getSetting('message_templates') || [];
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/templates', async (req, res) => {
  try {
    const s = await getStore();
    const { name, body } = req.body;
    if (!name || !body) return res.status(400).json({ ok: false, error: 'name and body required' });
    const templates = await s._getSetting('message_templates') || [];
    const idx = templates.findIndex(t => t.name === name);
    const template = { name, body, updated: Date.now() };
    if (idx >= 0) templates[idx] = template;
    else templates.push(template);
    await s._setSetting('message_templates', templates);
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/templates', async (req, res) => {
  try {
    const s = await getStore();
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    let templates = await s._getSetting('message_templates') || [];
    templates = templates.filter(t => t.name !== name);
    await s._setSetting('message_templates', templates);
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── WhatsApp routes return helpful message ──

const WA_OFFLINE = (req, res) => {
  res.status(503).json({
    ok: false,
    error: 'WhatsApp client is not available on Vercel. Run the local server for WhatsApp features (send, backfill, QR).'
  });
};

app.get('/api/qr', WA_OFFLINE);
app.post('/api/reconnect', WA_OFFLINE);
app.post('/api/send', WA_OFFLINE);
app.post('/api/broadcast', WA_OFFLINE);
app.post('/api/backfill', WA_OFFLINE);
app.get('/api/backfill/status', WA_OFFLINE);
app.get('/api/whatsapp/chats', WA_OFFLINE);
app.get('/api/whatsapp/contacts', WA_OFFLINE);
app.get('/api/whatsapp/conversation/:chatId', WA_OFFLINE);
app.get('/api/whatsapp/group/:chatId/participants', WA_OFFLINE);
app.post('/api/send-media', WA_OFFLINE);
app.post('/api/broadcast-media', WA_OFFLINE);

// Export for Vercel
module.exports = app;
