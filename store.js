/**
 * Supabase-backed Store
 * Replaces the old JSON file store with Supabase Postgres + real-time.
 * All methods are async since they hit the network.
 *
 * Server-side: uses SUPABASE_SERVICE_KEY (bypasses RLS for inserts).
 * Client-side: uses SUPABASE_ANON_KEY (RLS enforced, read-only for shared data).
 */

const { createClient } = require('@supabase/supabase-js');
let sentimentAI = null;
try { sentimentAI = require('./sentiment-ai'); } catch (e) { /* optional */ }

class Store {
  constructor() {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !serviceKey) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
    }

    // Server uses the service role key so it can INSERT into all tables (bypasses RLS)
    this.supabase = createClient(url, serviceKey);

    // In-memory caches for frequently-accessed values (avoid DB round-trips)
    this._cache = {
      myId: null,
      myLid: null,
      trackName: null,
      groupSettings: {},      // chatId -> { analytics, mentions, questions }
      partnerGroups: null,     // string[]
      internalStaff: null,     // string[]
      ignoredGroups: new Set() // chatIds that are fully ignored
    };

    this._cacheLoaded = false;
  }

  /**
   * Load frequently-used settings into memory. Call once on startup.
   */
  async init() {
    try {
      // Load app settings
      const { data: settings } = await this.supabase
        .from('app_settings')
        .select('key, value');

      if (settings) {
        for (const row of settings) {
          if (row.key === 'my_id') this._cache.myId = row.value;
          if (row.key === 'my_lid') this._cache.myLid = row.value;
          if (row.key === 'track_name') this._cache.trackName = row.value;
          if (row.key === 'partner_groups') this._cache.partnerGroups = row.value;
          if (row.key === 'internal_staff') this._cache.internalStaff = row.value;
          if (row.key === 'group_settings') this._cache.groupSettings = row.value || {};
        }
      }

      // Build ignored groups set from group settings
      this._rebuildIgnoredSet();

      this._cacheLoaded = true;
      console.log('[Store] Initialized with Supabase');
    } catch (err) {
      console.error('[Store] Init error:', err.message);
    }
  }

  // ═══════════════════════════════════════════
  // User Identity
  // ═══════════════════════════════════════════

  async setMyId(id) {
    this._cache.myId = id;
    await this._setSetting('my_id', id);
  }

  async getMyId() {
    if (this._cache.myId) return this._cache.myId;
    this._cache.myId = await this._getSetting('my_id');
    return this._cache.myId;
  }

  async setMyLid(lid) {
    this._cache.myLid = lid;
    await this._setSetting('my_lid', lid);
  }

  async getMyLid() {
    if (this._cache.myLid) return this._cache.myLid;
    this._cache.myLid = await this._getSetting('my_lid');
    return this._cache.myLid;
  }

  async getTrackName() {
    if (this._cache.trackName) return this._cache.trackName;
    this._cache.trackName = await this._getSetting('track_name');
    return this._cache.trackName || '';
  }

  async setTrackName(name) {
    this._cache.trackName = name;
    await this._setSetting('track_name', name);
  }

  // ═══════════════════════════════════════════
  // Group Tracking
  // ═══════════════════════════════════════════

  async recordGroupMessage({ chatId, chatName, sender, body, timestamp, hasMedia, mediaType }) {
    try {
      // Upsert group record
      await this._upsertGroup(chatId, chatName, sender, body, timestamp);

      // Check per-group analytics setting
      const groupSettings = await this.getGroupSettings(chatId);
      if (!groupSettings.analytics) return; // Skip stats if analytics disabled

      // Insert raw message
      await this.supabase.from('messages').insert({
        chat_id: chatId,
        chat_name: chatName,
        sender: sender || 'Unknown',
        body: (body || '').substring(0, 500),
        timestamp,
        has_media: hasMedia || false,
        media_type: mediaType || 'chat'
      });

      // Update message volume (hourly + daily)
      await this._incrementVolume(timestamp);

      // Update sender stats
      if (sender) {
        await this._upsertSenderStats(sender, timestamp, chatId);
      }

      // Add to activity feed
      await this._addToFeed({
        type: 'message', chatId, chatName, sender,
        body: (body || '').substring(0, 300),
        timestamp, hasMedia: hasMedia || false,
        mediaType: mediaType || 'chat'
      });
    } catch (err) {
      console.error('[Store] recordGroupMessage error:', err.message);
    }
  }

  async _upsertGroup(chatId, chatName, sender, body, timestamp) {
    // Try to get existing group
    const { data: existing } = await this.supabase
      .from('groups')
      .select('*')
      .eq('chat_id', chatId)
      .single();

    const todayKey = this._todayKey();

    if (!existing) {
      // Insert new group
      await this.supabase.from('groups').insert({
        chat_id: chatId,
        name: chatName,
        last_message: (body || '').substring(0, 200),
        last_message_time: timestamp,
        message_count: 1,
        today_count: 1,
        today_date: todayKey,
        members: sender ? [sender] : []
      });
    } else {
      // Build update object
      const update = {
        name: chatName,
        last_message_time: Math.max(existing.last_message_time || 0, timestamp),
        message_count: (existing.message_count || 0) + 1
      };

      // Update last message if this is the most recent
      if (timestamp >= (existing.last_message_time || 0)) {
        update.last_message = (body || '').substring(0, 200);
      }

      // Handle today count
      const msgDayKey = this._dayKey(timestamp);
      if (msgDayKey === todayKey) {
        if (existing.today_date !== todayKey) {
          update.today_count = 1;
          update.today_date = todayKey;
        } else {
          update.today_count = (existing.today_count || 0) + 1;
        }
      }

      // Add member if new
      const members = existing.members || [];
      if (sender && !members.includes(sender)) {
        update.members = [...members, sender];
      }

      await this.supabase
        .from('groups')
        .update(update)
        .eq('chat_id', chatId);
    }
  }

  // ═══════════════════════════════════════════
  // Direct Messages
  // ═══════════════════════════════════════════

  async addDirectMessage({ chatId, chatName, sender, body, timestamp, hasMedia, mediaType, fromMe }) {
    try {
      const id = `dm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await this.supabase.from('direct_messages').insert({
        id,
        chat_id: chatId,
        chat_name: chatName || '',
        sender: sender || 'Unknown',
        body: (body || '').substring(0, 500),
        timestamp,
        from_me: !!fromMe,
        has_media: hasMedia || false,
        media_type: mediaType || 'chat'
      });

      // Add to activity feed
      await this._addToFeed({
        type: 'dm', chatId, chatName, sender,
        body: (body || '').substring(0, 300),
        timestamp, hasMedia: hasMedia || false,
        mediaType: mediaType || 'chat'
      });

      return id;
    } catch (err) {
      console.error('[Store] addDirectMessage error:', err.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════
  // Mentions
  // ═══════════════════════════════════════════

  async addMention({ chatId, chatName, sender, body, timestamp, hasMedia, mediaType }) {
    try {
      // Skip if mentions disabled for this group
      if (chatId && chatId.endsWith('@g.us')) {
        const settings = await this.getGroupSettings(chatId);
        if (!settings.mentions) return null;
      }

      const id = `mention_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await this.supabase.from('mentions').insert({
        id,
        chat_id: chatId,
        chat_name: chatName,
        sender: sender || 'Unknown',
        body: (body || '').substring(0, 500),
        timestamp,
        has_media: hasMedia || false,
        media_type: mediaType || 'chat'
      });

      // Add to activity feed
      await this._addToFeed({
        type: 'mention', chatId, chatName, sender,
        body: (body || '').substring(0, 300),
        timestamp, hasMedia: hasMedia || false,
        mediaType: mediaType || 'chat'
      });

      return id;
    } catch (err) {
      console.error('[Store] addMention error:', err.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════
  // Questions (Enhanced v2)
  // ═══════════════════════════════════════════

  async addQuestion({ chatId, chatName, sender, body, timestamp, hasMedia, mediaType, msgId, questionAnalysis }) {
    try {
      // Skip if questions disabled for this group
      if (chatId && chatId.endsWith('@g.us')) {
        const settings = await this.getGroupSettings(chatId);
        if (!settings.questions) return null;
      }

      const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const qa = questionAnalysis || {};

      await this.supabase.from('questions').insert({
        id,
        chat_id: chatId,
        chat_name: chatName,
        sender: sender || 'Unknown',
        body: (body || '').substring(0, 500),
        timestamp,
        msg_id: msgId || null,
        directed_at_me: qa.directedAtMe || false,
        status: 'open',
        priority: qa.priority || 'normal',
        question_type: qa.questionType || 'general',
        keywords: qa.keywords || [],
        category: this._categorizeQuestion(chatName),
        has_media: hasMedia || false,
        media_type: mediaType || 'chat'
      });

      // Add to activity feed
      await this._addToFeed({
        type: 'question', chatId, chatName, sender,
        body: (body || '').substring(0, 300),
        timestamp, hasMedia: hasMedia || false,
        mediaType: mediaType || 'chat'
      });

      console.log(`[Question] ${qa.questionType || 'general'} (${qa.priority || 'normal'}) from ${sender} in ${chatName}`);
      return id;
    } catch (err) {
      console.error('[Store] addQuestion error:', err.message);
      return null;
    }
  }

  _categorizeQuestion(chatName) {
    const lower = (chatName || '').toLowerCase();
    if (lower.includes('team')) return 'team';
    if (lower.includes('onboarding')) return 'onboarding';
    if (lower.includes('support') || lower.includes('help')) return 'support';
    return 'general';
  }

  /**
   * Enhanced answer detection using the Analyzer's scoring system.
   * Records ALL candidates above threshold, auto-accepts high-confidence ones.
   */
  async checkForAnswers({ chatId, sender, body, timestamp, msgId, quotedMsgBody, quotedMsgSender, isQuotedReply, isMyMessage, recentMsgCount, analyzer }) {
    if (!body || body.length < 1) return;

    const now = timestamp || Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // extended to 24 hours

    // Get open questions in this chat
    const { data: pendingQs } = await this.supabase
      .from('questions')
      .select('*')
      .eq('chat_id', chatId)
      .eq('status', 'open');

    if (!pendingQs || pendingQs.length === 0) return;

    const candidateMsg = { body, sender };

    for (const q of pendingQs) {
      const age = now - q.timestamp;
      if (age < 2000 || age > maxAge) continue;

      // Use analyzer's enhanced scoring
      const { confidence, signals } = analyzer
        ? analyzer.scoreAnswer(q, candidateMsg, {
            isQuotedReply: isQuotedReply || false,
            quotedMsgBody,
            quotedMsgSender,
            isFromMe: isMyMessage || false,
            timeDeltaMs: age,
            recentMsgCount: recentMsgCount || 0
          })
        : { confidence: 0, signals: {} };

      // Record candidate if above minimum threshold (0.2)
      if (confidence >= 0.2) {
        const candidateId = `ac_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const isAccepted = confidence >= 0.5;

        await this.supabase.from('answer_candidates').insert({
          id: candidateId,
          question_id: q.id,
          chat_id: chatId,
          msg_id: msgId || null,
          sender: sender || 'Unknown',
          body: (body || '').substring(0, 500),
          timestamp: now,
          confidence,
          signals,
          is_quoted_reply: isQuotedReply || false,
          is_accepted: isAccepted
        });

        // Auto-accept: mark question as answered if confidence is high enough
        if (isAccepted) {
          const topSignal = Object.entries(signals)
            .filter(([, v]) => v.score > 0)
            .sort((a, b) => b[1].score - a[1].score)[0];

          await this.supabase
            .from('questions')
            .update({
              status: 'answered',
              answered_by: sender,
              answered_at: now,
              answer_confidence: confidence,
              answer_reason: topSignal ? topSignal[1].detail : 'multi-signal match',
              answer_preview: body.substring(0, 200),
              answer_id: candidateId
            })
            .eq('id', q.id);

          console.log(`[Answer] Question "${q.body?.substring(0, 40)}..." answered by ${sender} (confidence: ${confidence}, reason: ${topSignal ? topSignal[1].detail : 'multi-signal'})`);
        }
      }
    }
  }

  /**
   * Store context messages around a question (messages before/after in the chat)
   */
  async addQuestionContext(questionId, messages) {
    try {
      const rows = messages.map((m, i) => ({
        question_id: questionId,
        msg_id: m.msgId || null,
        chat_id: m.chatId,
        sender: m.sender || 'Unknown',
        body: (m.body || '').substring(0, 300),
        timestamp: m.timestamp,
        is_before: m.isBefore !== false,
        position: i
      }));
      if (rows.length > 0) {
        await this.supabase.from('question_context').insert(rows);
      }
    } catch (err) {
      console.error('[Store] addQuestionContext error:', err.message);
    }
  }

  // ── Manual Question Management ──

  async markQuestionAnswered(questionId, answeredBy) {
    await this.supabase
      .from('questions')
      .update({
        status: 'answered',
        answered_by: answeredBy || 'Manual',
        answered_at: Date.now(),
        answer_confidence: 1.0,
        answer_reason: 'manually resolved',
        manually_resolved: true
      })
      .eq('id', questionId);
  }

  async dismissQuestion(questionId, dismissedBy) {
    await this.supabase
      .from('questions')
      .update({
        status: 'dismissed',
        dismissed: true,
        dismissed_by: dismissedBy || 'Admin',
        dismissed_at: Date.now()
      })
      .eq('id', questionId);
  }

  async reopenQuestion(questionId) {
    await this.supabase
      .from('questions')
      .update({
        status: 'open',
        answered_by: null,
        answered_at: null,
        answer_confidence: null,
        answer_reason: null,
        answer_preview: null,
        answer_id: null,
        dismissed: false,
        dismissed_by: null,
        dismissed_at: null,
        manually_resolved: false
      })
      .eq('id', questionId);
  }

  async getQuestionWithCandidates(questionId) {
    const { data: question } = await this.supabase
      .from('questions')
      .select('*')
      .eq('id', questionId)
      .single();

    const { data: candidates } = await this.supabase
      .from('answer_candidates')
      .select('*')
      .eq('question_id', questionId)
      .order('confidence', { ascending: false });

    let { data: context } = await this.supabase
      .from('question_context')
      .select('*')
      .eq('question_id', questionId)
      .order('timestamp', { ascending: true });

    // Fallback: if no stored context, fetch surrounding messages from the messages table
    if ((!context || context.length === 0) && question && question.chat_id && question.timestamp) {
      const windowMs = 3600000; // 1 hour window
      const beforeTs = question.timestamp - windowMs;
      const afterTs = question.timestamp + windowMs;

      // Get messages before the question
      const { data: beforeMsgs } = await this.supabase
        .from('messages')
        .select('chat_id, sender, body, timestamp')
        .eq('chat_id', question.chat_id)
        .gte('timestamp', beforeTs)
        .lt('timestamp', question.timestamp)
        .order('timestamp', { ascending: false })
        .limit(5);

      // Get messages after the question
      const { data: afterMsgs } = await this.supabase
        .from('messages')
        .select('chat_id, sender, body, timestamp')
        .eq('chat_id', question.chat_id)
        .gt('timestamp', question.timestamp)
        .lte('timestamp', afterTs)
        .order('timestamp', { ascending: true })
        .limit(5);

      context = [];
      if (beforeMsgs) {
        context.push(...beforeMsgs.reverse().map(m => ({
          question_id: questionId,
          chat_id: m.chat_id,
          sender: m.sender,
          body: m.body,
          timestamp: m.timestamp,
          is_before: true
        })));
      }
      if (afterMsgs) {
        context.push(...afterMsgs.map(m => ({
          question_id: questionId,
          chat_id: m.chat_id,
          sender: m.sender,
          body: m.body,
          timestamp: m.timestamp,
          is_before: false
        })));
      }
    }

    return { question, candidates: candidates || [], context: context || [] };
  }

  async acceptAnswerCandidate(candidateId) {
    const { data: candidate } = await this.supabase
      .from('answer_candidates')
      .select('*')
      .eq('id', candidateId)
      .single();

    if (!candidate) return;

    // Mark this candidate as accepted
    await this.supabase
      .from('answer_candidates')
      .update({ is_accepted: true })
      .eq('id', candidateId);

    // Un-accept any other candidates for this question
    await this.supabase
      .from('answer_candidates')
      .update({ is_accepted: false })
      .neq('id', candidateId)
      .eq('question_id', candidate.question_id);

    // Update the question
    await this.supabase
      .from('questions')
      .update({
        status: 'answered',
        answered_by: candidate.sender,
        answered_at: candidate.timestamp,
        answer_confidence: candidate.confidence,
        answer_reason: 'manually accepted',
        answer_preview: (candidate.body || '').substring(0, 200),
        answer_id: candidateId,
        manually_resolved: true
      })
      .eq('id', candidate.question_id);
  }

  // ═══════════════════════════════════════════
  // AI Classification Updates
  // ═══════════════════════════════════════════

  /**
   * Update a question's classification with AI results.
   * If AI says it's NOT a question, we can reclassify it.
   */
  async updateQuestionAIClassification(questionId, aiResult) {
    if (!aiResult) return;

    const update = {
      classified_by: 'ai',
      ai_confidence: aiResult.confidence || 0,
      ai_intent: aiResult.intent || 'other',
      ai_summary: aiResult.summary || '',
      ai_is_actionable: aiResult.isActionable || false
    };

    // If AI says it's a question, update type/priority too
    if (aiResult.intent === 'question' && aiResult.questionType) {
      update.question_type = aiResult.questionType;
      update.priority = aiResult.priority || 'normal';
    }

    // If AI says it's NOT a question with high confidence, dismiss it
    if (aiResult.intent !== 'question' && aiResult.confidence >= 0.8) {
      update.status = 'dismissed';
      update.dismissed = true;
      update.dismissed_by = 'AI (not a question)';
      update.dismissed_at = Date.now();
      console.log(`[AI] Reclassified question ${questionId} as "${aiResult.intent}" — auto-dismissed`);
    }

    await this.supabase
      .from('questions')
      .update(update)
      .eq('id', questionId);
  }

  /**
   * Update a raw message's AI classification.
   */
  async updateMessageAIClassification(messageId, aiResult) {
    if (!aiResult) return;

    await this.supabase
      .from('messages')
      .update({
        classified_by: 'ai',
        ai_intent: aiResult.intent || 'other',
        ai_confidence: aiResult.confidence || 0,
        ai_summary: aiResult.summary || '',
        ai_is_actionable: aiResult.isActionable || false
      })
      .eq('id', messageId);
  }

  /**
   * Promote a message to a question (when AI detects a question that regex missed).
   */
  async promoteMessageToQuestion(messageRow, aiResult) {
    const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await this.supabase.from('questions').insert({
      id,
      chat_id: messageRow.chat_id,
      chat_name: messageRow.chat_name,
      sender: messageRow.sender || 'Unknown',
      body: (messageRow.body || '').substring(0, 500),
      timestamp: messageRow.timestamp,
      msg_id: messageRow.id ? String(messageRow.id) : null,
      status: 'open',
      priority: aiResult.priority || 'normal',
      question_type: aiResult.questionType || 'general',
      keywords: [],
      category: this._categorizeQuestion(messageRow.chat_name),
      classified_by: 'ai',
      ai_confidence: aiResult.confidence || 0,
      ai_intent: 'question',
      ai_summary: aiResult.summary || '',
      ai_is_actionable: aiResult.isActionable || false
    });

    console.log(`[AI] Promoted message to question: "${(messageRow.body || '').substring(0, 40)}..." from ${messageRow.sender}`);
    return id;
  }

  /**
   * Get unclassified messages for bulk AI processing.
   */
  async getUnclassifiedMessages(limit = 50) {
    const { data } = await this.supabase
      .from('messages')
      .select('*')
      .eq('classified_by', 'none')
      .order('timestamp', { ascending: false })
      .limit(limit);
    return data || [];
  }

  /**
   * Get AI classifier stats.
   */
  async getAIClassificationStats() {
    const { count: totalMessages } = await this.supabase
      .from('messages')
      .select('*', { count: 'exact', head: true });

    const { count: aiClassified } = await this.supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('classified_by', 'ai');

    const { count: regexClassified } = await this.supabase
      .from('questions')
      .select('*', { count: 'exact', head: true })
      .eq('classified_by', 'regex');

    const { count: aiQuestions } = await this.supabase
      .from('questions')
      .select('*', { count: 'exact', head: true })
      .eq('classified_by', 'ai');

    const { count: aiDismissed } = await this.supabase
      .from('questions')
      .select('*', { count: 'exact', head: true })
      .eq('dismissed_by', 'AI (not a question)');

    return {
      totalMessages: totalMessages || 0,
      aiClassifiedMessages: aiClassified || 0,
      regexClassifiedQuestions: regexClassified || 0,
      aiClassifiedQuestions: aiQuestions || 0,
      aiDismissedFalsePositives: aiDismissed || 0,
      unclassified: (totalMessages || 0) - (aiClassified || 0)
    };
  }

  // ═══════════════════════════════════════════
  // Group Settings (per-group tracking toggles)
  // ═══════════════════════════════════════════

  async getGroupSettings(chatId) {
    if (this._cache.groupSettings[chatId]) {
      return this._cache.groupSettings[chatId];
    }
    return { analytics: true, mentions: true, questions: true };
  }

  async setGroupCategorySetting(chatId, category, enabled) {
    if (!this._cache.groupSettings[chatId]) {
      this._cache.groupSettings[chatId] = { analytics: true, mentions: true, questions: true };
    }
    this._cache.groupSettings[chatId][category] = enabled;
    this._rebuildIgnoredSet();
    await this._setSetting('group_settings', this._cache.groupSettings);
  }

  async setGroupAllSettings(chatId, settings) {
    this._cache.groupSettings[chatId] = { ...settings };
    this._rebuildIgnoredSet();
    await this._setSetting('group_settings', this._cache.groupSettings);
  }

  async isGroupIgnored(chatId) {
    const s = await this.getGroupSettings(chatId);
    return !s.analytics && !s.mentions && !s.questions;
  }

  async setGroupIgnored(chatId, ignored) {
    if (ignored) {
      await this.setGroupAllSettings(chatId, { analytics: false, mentions: false, questions: false });
    } else {
      await this.setGroupAllSettings(chatId, { analytics: true, mentions: true, questions: true });
    }
    // Also update the is_ignored flag on the groups table
    await this.supabase
      .from('groups')
      .update({ is_ignored: ignored })
      .eq('chat_id', chatId);
  }

  _rebuildIgnoredSet() {
    this._cache.ignoredGroups = new Set();
    for (const [chatId, settings] of Object.entries(this._cache.groupSettings)) {
      if (!settings.analytics && !settings.mentions && !settings.questions) {
        this._cache.ignoredGroups.add(chatId);
      }
    }
  }

  // ═══════════════════════════════════════════
  // Data Retrieval (for API endpoints / frontend)
  // ═══════════════════════════════════════════

  async getGroups() {
    const { data } = await this.supabase
      .from('groups')
      .select('*')
      .order('last_message_time', { ascending: false });
    return data || [];
  }

  async getGroupsSorted(includeIgnored = false) {
    let query = this.supabase
      .from('groups')
      .select('*')
      .order('last_message_time', { ascending: false });

    if (!includeIgnored) {
      query = query.eq('is_ignored', false);
    }

    const { data } = await query;
    return data || [];
  }

  async getMentions(limit = 200) {
    const { data } = await this.supabase
      .from('mentions')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);
    return data || [];
  }

  async getDirectMessages(limit = 200) {
    const { data } = await this.supabase
      .from('direct_messages')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);
    return data || [];
  }

  async resolveMention(id, resolvedBy = 'team') {
    try {
      const { error } = await this.supabase
        .from('mentions')
        .update({ resolved: true, resolved_by: resolvedBy, resolved_at: Date.now() })
        .eq('id', id);
      if (error) throw error;
      return true;
    } catch (err) {
      console.error('[Store] resolveMention error:', err.message);
      return false;
    }
  }

  async unresolvedMention(id) {
    try {
      const { error } = await this.supabase
        .from('mentions')
        .update({ resolved: false, resolved_by: null, resolved_at: null })
        .eq('id', id);
      if (error) throw error;
      return true;
    } catch (err) {
      console.error('[Store] unresolvedMention error:', err.message);
      return false;
    }
  }

  async resolveDM(id, resolvedBy = 'team') {
    try {
      const { error } = await this.supabase
        .from('direct_messages')
        .update({ resolved: true, resolved_by: resolvedBy, resolved_at: Date.now() })
        .eq('id', id);
      if (error) throw error;
      return true;
    } catch (err) {
      console.error('[Store] resolveDM error:', err.message);
      return false;
    }
  }

  async unresolvedDM(id) {
    try {
      const { error } = await this.supabase
        .from('direct_messages')
        .update({ resolved: false, resolved_by: null, resolved_at: null })
        .eq('id', id);
      if (error) throw error;
      return true;
    } catch (err) {
      console.error('[Store] unresolvedDM error:', err.message);
      return false;
    }
  }

  async getQuestions(unansweredOnly = false, limit = 200) {
    let query = this.supabase
      .from('questions')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (unansweredOnly) {
      query = query.eq('status', 'open');
    }

    const { data } = await query;
    return data || [];
  }

  async getActivityFeed(limit = 50) {
    const { data } = await this.supabase
      .from('activity_feed')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);
    return data || [];
  }

  async getDashboardStats() {
    const now = Date.now();
    const oneDayAgo = now - 86400000;
    const todayKey = this._todayKey();

    // Get groups
    const groups = await this.getGroups();

    // Today's messages (sum todayCount where todayDate matches)
    const todayMessages = groups.reduce((sum, g) => {
      return sum + (g.today_date === todayKey ? (g.today_count || 0) : 0);
    }, 0);

    const activeGroupsToday = groups.filter(g => g.last_message_time > oneDayAgo).length;

    // Pending questions
    const { count: pendingQuestions } = await this.supabase
      .from('questions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open');

    // Unresolved mentions only
    const { count: unresolvedMentions } = await this.supabase
      .from('mentions')
      .select('*', { count: 'exact', head: true })
      .or('resolved.is.null,resolved.eq.false');

    // Total mentions (for reference)
    const { count: totalMentions } = await this.supabase
      .from('mentions')
      .select('*', { count: 'exact', head: true });

    // Unresolved DMs only
    const { count: unresolvedDMs } = await this.supabase
      .from('direct_messages')
      .select('*', { count: 'exact', head: true })
      .or('resolved.is.null,resolved.eq.false');

    // Total DMs (for reference)
    const { count: totalDMs } = await this.supabase
      .from('direct_messages')
      .select('*', { count: 'exact', head: true });

    // Answered questions count (for response rate)
    const { count: answeredQuestions } = await this.supabase
      .from('questions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'answered');

    return {
      todayMessages,
      activeGroupsToday,
      totalGroups: groups.length,
      pendingQuestions: pendingQuestions || 0,
      unresolvedMentions: unresolvedMentions || 0,
      totalMentions: totalMentions || 0,
      unresolvedDMs: unresolvedDMs || 0,
      totalDMs: totalDMs || 0,
      answeredQuestions: answeredQuestions || 0
    };
  }

  // ═══════════════════════════════════════════
  // Partner Groups
  // ═══════════════════════════════════════════

  async getPartnerGroupNames() {
    if (this._cache.partnerGroups) return this._cache.partnerGroups;
    const val = await this._getSetting('partner_groups');
    this._cache.partnerGroups = val || [];
    return this._cache.partnerGroups;
  }

  async addPartnerGroup(name) {
    const groups = await this.getPartnerGroupNames();
    const trimmed = name.trim();
    if (trimmed && !groups.some(n => n.toLowerCase() === trimmed.toLowerCase())) {
      groups.push(trimmed);
      this._cache.partnerGroups = groups;
      await this._setSetting('partner_groups', groups);
    }
  }

  async removePartnerGroup(name) {
    let groups = await this.getPartnerGroupNames();
    groups = groups.filter(n => n.toLowerCase() !== name.toLowerCase());
    this._cache.partnerGroups = groups;
    await this._setSetting('partner_groups', groups);
  }

  // ═══════════════════════════════════════════
  // Internal Staff
  // ═══════════════════════════════════════════

  async getInternalStaff() {
    if (this._cache.internalStaff) return this._cache.internalStaff;
    const val = await this._getSetting('internal_staff');
    this._cache.internalStaff = val || [];
    return this._cache.internalStaff;
  }

  async addInternalStaff(name) {
    const staff = await this.getInternalStaff();
    const trimmed = name.trim().toLowerCase();
    if (trimmed && !staff.includes(trimmed)) {
      staff.push(trimmed);
      this._cache.internalStaff = staff;
      await this._setSetting('internal_staff', staff);
    }
  }

  async removeInternalStaff(name) {
    let staff = await this.getInternalStaff();
    staff = staff.filter(n => n !== name.toLowerCase());
    this._cache.internalStaff = staff;
    await this._setSetting('internal_staff', staff);
  }

  // ═══════════════════════════════════════════
  // Setup / Config
  // ═══════════════════════════════════════════

  async isSetupComplete() {
    const val = await this._getSetting('setup_complete');
    return val === true;
  }

  async completeSetup() {
    await this._setSetting('setup_complete', true);
  }

  async getCatchUpSettings() {
    const enabled = await this._getSetting('catch_up_enabled');
    const limit = await this._getSetting('catch_up_limit');
    return {
      enabled: enabled !== false,
      limit: limit || 100
    };
  }

  // ═══════════════════════════════════════════
  // Message Volume
  // ═══════════════════════════════════════════

  async _incrementVolume(timestamp) {
    const hourKey = `hourly:${this._hourKey(timestamp)}`;
    const dayKey = `daily:${this._dayKey(timestamp)}`;

    // Upsert hourly
    try {
      const { error } = await this.supabase.rpc('increment_volume', { volume_key: hourKey });
      if (error) await this._upsertVolume(hourKey);
    } catch {
      await this._upsertVolume(hourKey);
    }

    // Upsert daily
    try {
      const { error } = await this.supabase.rpc('increment_volume', { volume_key: dayKey });
      if (error) await this._upsertVolume(dayKey);
    } catch {
      await this._upsertVolume(dayKey);
    }
  }

  async _upsertVolume(key) {
    const { data: existing } = await this.supabase
      .from('message_volume')
      .select('count')
      .eq('key', key)
      .single();

    if (existing) {
      await this.supabase
        .from('message_volume')
        .update({ count: existing.count + 1, updated_at: new Date().toISOString() })
        .eq('key', key);
    } else {
      await this.supabase
        .from('message_volume')
        .insert({ key, count: 1 });
    }
  }

  async getHourlyVolume(hoursBack = 24) {
    const result = [];
    const now = new Date();
    for (let i = hoursBack - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3600000);
      const key = `hourly:${this._hourKey(d.getTime())}`;
      result.push({ hour: d.getHours(), label: `${d.getHours()}:00`, key });
    }

    // Batch fetch all keys
    const keys = result.map(r => r.key);
    const { data } = await this.supabase
      .from('message_volume')
      .select('key, count')
      .in('key', keys);

    const countMap = {};
    if (data) {
      for (const row of data) countMap[row.key] = row.count;
    }

    return result.map(r => ({
      hour: r.hour,
      label: r.label,
      count: countMap[r.key] || 0
    }));
  }

  async getDailyVolume(daysBack = 7) {
    const result = [];
    const now = new Date();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = `daily:${this._dayKey(d.getTime())}`;
      result.push({ date: this._dayKey(d.getTime()), label: dayNames[d.getDay()], key });
    }

    const keys = result.map(r => r.key);
    const { data } = await this.supabase
      .from('message_volume')
      .select('key, count')
      .in('key', keys);

    const countMap = {};
    if (data) {
      for (const row of data) countMap[row.key] = row.count;
    }

    return result.map(r => ({
      date: r.date,
      label: r.label,
      count: countMap[r.key] || 0
    }));
  }

  // ═══════════════════════════════════════════
  // Sender Stats
  // ═══════════════════════════════════════════

  async _upsertSenderStats(sender, timestamp, chatId) {
    const { data: existing } = await this.supabase
      .from('sender_stats')
      .select('*')
      .eq('sender', sender)
      .single();

    if (existing) {
      const groups = existing.groups || [];
      if (!groups.includes(chatId)) groups.push(chatId);

      await this.supabase
        .from('sender_stats')
        .update({
          message_count: existing.message_count + 1,
          last_seen: Math.max(existing.last_seen || 0, timestamp),
          groups,
          updated_at: new Date().toISOString()
        })
        .eq('sender', sender);
    } else {
      await this.supabase
        .from('sender_stats')
        .insert({
          sender,
          message_count: 1,
          last_seen: timestamp,
          groups: [chatId]
        });
    }
  }

  async getTopSenders(limit = 10) {
    const { data } = await this.supabase
      .from('sender_stats')
      .select('*')
      .order('message_count', { ascending: false })
      .limit(limit);
    return data || [];
  }

  // ═══════════════════════════════════════════
  // Tasks (Microsoft To-Do style)
  // ═══════════════════════════════════════════

  async addTask({ title, body, chatId, chatName, sender, sourceType, sourceId, priority, assignedTo, dueDate, steps, category }) {
    try {
      const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();

      await this.supabase.from('tasks').insert({
        id,
        title: (title || '').substring(0, 500),
        body: body || '',
        chat_id: chatId || null,
        chat_name: chatName || '',
        sender: sender || '',
        source_type: sourceType || 'manual',
        source_id: sourceId || null,
        status: 'open',
        priority: priority || 'normal',
        category: category || 'general',
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        steps: steps || [],
        timestamp: now
      });

      // Add to activity feed
      await this._addToFeed({
        type: 'task',
        chatId: chatId || 'tasks',
        chatName: chatName || 'Tasks',
        sender: 'System',
        body: `Task created: ${(title || '').substring(0, 200)}`,
        timestamp: now,
        hasMedia: false,
        mediaType: 'chat'
      });

      console.log(`[Task] Created: "${(title || '').substring(0, 40)}..." (${priority || 'normal'}) assigned to ${assignedTo || 'unassigned'}`);
      return id;
    } catch (err) {
      console.error('[Store] addTask error:', err.message);
      return null;
    }
  }

  async getTasks({ status, assignee, priority, myDay, limit } = {}) {
    let query = this.supabase
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }
    if (assignee) {
      query = query.eq('assigned_to', assignee);
    }
    if (priority) {
      query = query.eq('priority', priority);
    }
    if (myDay) {
      query = query.eq('my_day', true);
    }
    if (limit) {
      query = query.limit(limit);
    } else {
      query = query.limit(500);
    }

    const { data } = await query;
    return data || [];
  }

  async getTask(taskId) {
    const { data } = await this.supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single();
    return data;
  }

  async updateTask(taskId, updates) {
    try {
      const allowed = ['title', 'body', 'priority', 'assigned_to', 'due_date', 'steps', 'category', 'my_day', 'status', 'tags'];
      const clean = {};
      for (const key of allowed) {
        if (updates[key] !== undefined) clean[key] = updates[key];
      }
      clean.updated_at = new Date().toISOString();

      await this.supabase
        .from('tasks')
        .update(clean)
        .eq('id', taskId);

      return true;
    } catch (err) {
      console.error('[Store] updateTask error:', err.message);
      return false;
    }
  }

  async completeTask(taskId, completedBy) {
    try {
      const now = Date.now();
      await this.supabase
        .from('tasks')
        .update({
          status: 'completed',
          completed_by: completedBy || 'team',
          completed_at: now,
          updated_at: new Date().toISOString()
        })
        .eq('id', taskId);
      return true;
    } catch (err) {
      console.error('[Store] completeTask error:', err.message);
      return false;
    }
  }

  async reopenTask(taskId) {
    try {
      await this.supabase
        .from('tasks')
        .update({
          status: 'open',
          completed_by: null,
          completed_at: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', taskId);
      return true;
    } catch (err) {
      console.error('[Store] reopenTask error:', err.message);
      return false;
    }
  }

  async deleteTask(taskId) {
    try {
      await this.supabase
        .from('tasks')
        .delete()
        .eq('id', taskId);
      return true;
    } catch (err) {
      console.error('[Store] deleteTask error:', err.message);
      return false;
    }
  }

  async getTaskStats() {
    const { count: open } = await this.supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open');

    const { count: inProgress } = await this.supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'in_progress');

    const { count: completed } = await this.supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed');

    const { count: overdue } = await this.supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .in('status', ['open', 'in_progress'])
      .lt('due_date', Date.now())
      .not('due_date', 'is', null);

    return {
      open: open || 0,
      inProgress: inProgress || 0,
      completed: completed || 0,
      overdue: overdue || 0,
      total: (open || 0) + (inProgress || 0) + (completed || 0)
    };
  }

  // ═══════════════════════════════════════════
  // Activity Feed
  // ═══════════════════════════════════════════

  async _addToFeed({ type, chatId, chatName, sender, body, timestamp, hasMedia, mediaType }) {
    // Check for existing entry with same sender+body+timestamp+chat to prevent duplicates
    const trimmedBody = (body || '').substring(0, 300);
    const { data: existing } = await this.supabase
      .from('activity_feed')
      .select('id')
      .eq('chat_id', chatId)
      .eq('sender', sender || 'Unknown')
      .eq('timestamp', timestamp)
      .eq('body', trimmedBody)
      .limit(1);

    if (existing && existing.length > 0) return; // Already exists, skip

    await this.supabase.from('activity_feed').insert({
      type,
      chat_id: chatId,
      chat_name: chatName || '',
      sender: sender || 'Unknown',
      body: trimmedBody,
      timestamp,
      has_media: hasMedia || false,
      media_type: mediaType || 'chat'
    });
  }

  // ═══════════════════════════════════════════
  // App Settings (generic key-value via app_settings table)
  // ═══════════════════════════════════════════

  async _getSetting(key) {
    try {
      const { data } = await this.supabase
        .from('app_settings')
        .select('value')
        .eq('key', key)
        .single();
      return data ? data.value : null;
    } catch {
      return null;
    }
  }

  async _setSetting(key, value) {
    await this.supabase
      .from('app_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  }

  // ═══════════════════════════════════════════
  // Date Helpers
  // ═══════════════════════════════════════════

  _todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  _hourKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}`;
  }

  _dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ═══════════════════════════════════════════
  // Force Save (no-op for Supabase, kept for API compat)
  // ═══════════════════════════════════════════

  async forceSave() {
    // No-op — Supabase writes are immediate
  }
}

module.exports = Store;
