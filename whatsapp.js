const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

// Data directory for WhatsApp auth session (server-side, no Electron)
const DATA_DIR = process.env.WWEBJS_DATA_DIR || path.join(__dirname, '.wwebjs_data');

// Find a usable Chrome/Chromium binary on the system
function findChromePath() {
  const candidates = [
    // macOS Chrome locations
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    // Home-dir installs (macOS)
    path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    // Linux locations
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // Windows locations
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const chromePath of candidates) {
    try {
      if (fs.existsSync(chromePath)) {
        console.log('[Chrome] Found browser at:', chromePath);
        return chromePath;
      }
    } catch { /* skip */ }
  }
  return null;
}

class WhatsAppService extends EventEmitter {
  constructor(store, analyzer, aiClassifier = null) {
    super();
    this.store = store;
    this.analyzer = analyzer;
    this.aiClassifier = aiClassifier;
    this.client = null;
    this.ready = false;
  }

  async initialize() {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Try to find Chrome — prefer PUPPETEER_EXECUTABLE_PATH env var (set by Docker/Railway)
    const envChrome = process.env.PUPPETEER_EXECUTABLE_PATH;
    const systemChrome = envChrome || findChromePath();
    const puppeteerOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    };
    if (systemChrome) {
      puppeteerOpts.executablePath = systemChrome;
    }

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(DATA_DIR, '.wwebjs_auth')
      }),
      puppeteer: puppeteerOpts
    });

    // ── QR Code Event ──
    this.client.on('qr', async (qr) => {
      console.log('QR code received');
      try {
        const dataUrl = await QRCode.toDataURL(qr, {
          width: 256,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
        this.emit('qr', dataUrl);
      } catch (err) {
        console.error('Failed to generate QR image:', err);
        this.emit('qr', qr);
      }
    });

    // ── Authentication Events ──
    this.client.on('authenticated', () => {
      console.log('WhatsApp authenticated');
      this.emit('authenticated');
    });

    this.client.on('auth_failure', (msg) => {
      console.error('Auth failure:', msg);
      this.emit('auth_failure', msg);
    });

    // ── Ready Event ──
    this.client.on('ready', async () => {
      console.log('=== WhatsApp client ready ===');
      console.log('Listening for messages...');
      this.ready = true;

      const info = this.client.info;
      if (info && info.wid) {
        console.log('My WhatsApp ID:', info.wid._serialized);
        await this.store.setMyId(info.wid._serialized);
      }
      if (info && info.lid) {
        console.log('My Linked ID:', info.lid._serialized);
        await this.store.setMyLid(info.lid._serialized);
      }

      this.emit('ready');
    });

    // ── Message Events ──
    this.client.on('message', async (message) => {
      try {
        console.log(`[MSG IN] from=${message.from} type=${message.type} body="${(message.body || '').substring(0, 50)}"`);
        await this._handleMessage(message);
      } catch (err) {
        console.error('Error handling message:', err);
      }
    });

    this.client.on('message_create', async (message) => {
      if (message.fromMe) {
        try {
          const chatId = message.to || message.from;
          const trackName = await this.store.getTrackName();

          let chat;
          try { chat = await message.getChat(); } catch { /* ok */ }
          const chatName = (chat && chat.name) ? chat.name : chatId;
          const timestamp = message.timestamp ? message.timestamp * 1000 : Date.now();

          if (chat && chat.isGroup) {
            await this.store.recordGroupMessage({
              chatId,
              chatName,
              sender: trackName || 'Me',
              body: message.body || '',
              timestamp,
              hasMedia: message.hasMedia || false,
              mediaType: message.type || 'chat'
            });
          } else if (chat && !chat.isGroup) {
            await this.store.addDirectMessage({
              chatId,
              chatName: chatName || 'DM',
              sender: trackName || 'You',
              body: (message.body || '').substring(0, 500),
              timestamp,
              hasMedia: message.hasMedia || false,
              mediaType: message.type || 'chat',
              fromMe: true
            });
          }

          // Smart answer detection for our own messages
          const outMsgId = message.id ? (message.id._serialized || message.id.id) : null;
          let quotedMsgBody = null;
          let quotedMsgSender = null;
          let isQuotedReply = false;
          try {
            if (message.hasQuotedMsg) {
              isQuotedReply = true;
              const quoted = await message.getQuotedMessage();
              if (quoted) {
                quotedMsgBody = (quoted.body || '').substring(0, 500);
                try {
                  const quotedContact = await quoted.getContact();
                  quotedMsgSender = quotedContact.pushname || quotedContact.name || quotedContact.number || 'Unknown';
                } catch {
                  quotedMsgSender = quoted.from || 'Unknown';
                }
              }
            }
          } catch { /* ok */ }

          await this.store.checkForAnswers({
            chatId,
            sender: trackName || 'Me',
            body: message.body || '',
            timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
            msgId: outMsgId,
            quotedMsgBody,
            quotedMsgSender,
            isQuotedReply,
            isMyMessage: true,
            recentMsgCount: 0,
            analyzer: this.analyzer
          });

          this.emit('data_updated');
        } catch (err) {
          console.error('Error handling outgoing message:', err);
        }
      }
    });

    // ── State Change ──
    this.client.on('change_state', (state) => {
      console.log(`[STATE] WhatsApp state changed to: ${state}`);
    });

    // ── Disconnection ──
    this.client.on('disconnected', (reason) => {
      console.log('WhatsApp disconnected:', reason);
      this.ready = false;
      this.emit('disconnected', reason);
    });

    // Start the client
    try {
      await this.client.initialize();
    } catch (err) {
      console.error('Failed to initialize WhatsApp client:', err);
      this.emit('error', err);
    }
  }

  async _handleMessage(message) {
    const myId = await this.store.getMyId();
    let myLid = await this.store.getMyLid();

    // Skip our own messages
    if (message.fromMe) return;

    // Get chat info
    let chat;
    try {
      chat = await message.getChat();
    } catch (err) {
      console.error('[CHAT ERR] Could not get chat:', err.message);
      return;
    }

    const chatName = chat.name || chat.id._serialized;
    const chatId = chat.id._serialized;
    const isGroupChat = chat.isGroup;

    // Get sender info
    let senderName = 'Unknown';
    try {
      const contact = await message.getContact();
      senderName = contact.pushname || contact.name || contact.number || 'Unknown';
    } catch {
      senderName = message.from || 'Unknown';
    }

    const timestamp = message.timestamp * 1000 || Date.now();
    const hasMedia = message.hasMedia || false;
    const mediaType = message.type || 'chat';

    // ── ALWAYS record group activity for dashboard ──
    if (isGroupChat) {
      await this.store.recordGroupMessage({
        chatId,
        chatName,
        sender: senderName,
        body: message.body,
        timestamp,
        hasMedia,
        mediaType
      });

      // Skip all further processing if group is fully ignored
      const isIgnored = await this.store.isGroupIgnored(chatId);
      if (isIgnored) {
        return;
      }
    }

    // Auto-learn LID
    if (!myLid && message.mentionedIds && message.mentionedIds.length > 0) {
      for (const mentionId of message.mentionedIds) {
        const mentionStr = String(mentionId);
        if (mentionStr.endsWith('@lid')) {
          try {
            const contact = await this.client.getContactById(mentionStr);
            const contactNumber = contact?.number || contact?.id?.user || '';
            const myNumber = myId ? myId.split('@')[0] : '';
            if (myNumber && contactNumber && (contactNumber === myNumber || contactNumber.endsWith(myNumber) || myNumber.endsWith(contactNumber))) {
              console.log('Auto-learned my Linked ID:', mentionStr);
              await this.store.setMyLid(mentionStr);
              myLid = mentionStr;
            }
          } catch (err) {
            // LID lookup failed, will retry
          }
        }
      }
    }

    // Analyze the message
    const analysis = this.analyzer.analyze(message, myId, myLid, isGroupChat);

    if (analysis.isMention || analysis.isDirectedQuestion || analysis.isDirectMessage) {
      const tags = [];
      if (analysis.isDirectMessage) tags.push('DM');
      if (analysis.isMention) tags.push('Mention');
      if (analysis.isDirectedQuestion) tags.push('Question');
      console.log(`[${tags.join('+')}] from "${senderName}" in "${chatName}"`);
    }

    let updated = false;

    const msgData = {
      chatId,
      chatName,
      sender: senderName,
      body: (message.body || '').substring(0, 500),
      timestamp,
      hasMedia,
      mediaType
    };

    if (analysis.isDirectMessage) {
      await this.store.addDirectMessage(msgData);
      this.emit('notification', { type: 'dm', sender: senderName, body: (message.body || '').substring(0, 120), chatId, chatName, timestamp });
      updated = true;
    }

    if (analysis.isMention && !analysis.isDirectMessage) {
      await this.store.addMention(msgData);
      this.emit('notification', { type: 'mention', sender: senderName, body: (message.body || '').substring(0, 120), chatId, chatName, timestamp });
      updated = true;
    }

    // Get message ID and quoted message info (used by both question tracking and answer detection)
    const msgId = message.id ? (message.id._serialized || message.id.id) : null;
    let quotedMsgBody = null;
    let quotedMsgSender = null;
    let isQuotedReply = false;
    try {
      if (message.hasQuotedMsg) {
        isQuotedReply = true;
        const quoted = await message.getQuotedMessage();
        if (quoted) {
          quotedMsgBody = (quoted.body || '').substring(0, 500);
          try {
            const quotedContact = await quoted.getContact();
            quotedMsgSender = quotedContact.pushname || quotedContact.name || quotedContact.number || 'Unknown';
          } catch {
            quotedMsgSender = quoted.from || 'Unknown';
          }
        }
      }
    } catch {
      // Quoted message retrieval failed
    }

    if (analysis.isQuestion) {
      const questionId = await this.store.addQuestion({
        ...msgData,
        msgId,
        questionAnalysis: analysis.questionAnalysis || {}
      });

      // Store context messages around the question (recent chat history)
      if (questionId && isGroupChat) {
        try {
          const recentMsgs = await chat.fetchMessages({ limit: 6 });
          const contextMessages = recentMsgs
            .filter(m => m.id._serialized !== msgId)
            .slice(-5)
            .map(m => ({
              msgId: m.id ? (m.id._serialized || m.id.id) : null,
              chatId,
              sender: m.fromMe ? 'Me' : (m.author || m.from || 'Unknown'),
              body: (m.body || '').substring(0, 300),
              timestamp: m.timestamp ? m.timestamp * 1000 : Date.now(),
              isBefore: (m.timestamp || 0) * 1000 < timestamp
            }));
          if (contextMessages.length > 0) {
            await this.store.addQuestionContext(questionId, contextMessages);
          }
        } catch (err) {
          console.error('[Context] Failed to fetch context messages:', err.message);
        }
      }

      // Queue for AI verification (async — won't block message processing)
      if (this.aiClassifier && questionId) {
        this.aiClassifier.queueMessage({
          id: questionId,
          body: message.body || '',
          sender: senderName,
          chatName,
          isGroupChat,
          regexResult: analysis.questionAnalysis,
          onClassified: async (id, aiResult) => {
            await this.store.updateQuestionAIClassification(id, aiResult);
          }
        });
      }

      updated = true;
    }

    // For non-question messages in groups, queue for AI classification
    // (AI might catch questions that regex missed)
    if (isGroupChat && !analysis.isQuestion && this.aiClassifier) {
      this.aiClassifier.queueMessage({
        id: `msg_check_${msgId || Date.now()}`,
        body: message.body || '',
        sender: senderName,
        chatName,
        isGroupChat,
        regexResult: null,
        onClassified: async (id, aiResult) => {
          // If AI detected a question regex missed, promote it
          if (aiResult && aiResult.intent === 'question' && aiResult.confidence >= 0.7) {
            await this.store.promoteMessageToQuestion({
              chat_id: chatId,
              chat_name: chatName,
              sender: senderName,
              body: (message.body || '').substring(0, 500),
              timestamp,
              id: msgId
            }, aiResult);
            console.log(`[AI] Caught missed question: "${(message.body || '').substring(0, 40)}..." from ${senderName}`);
          }

          // If AI detected an approval (response to an offer sheet)
          if (aiResult && aiResult.intent === 'approval' && aiResult.confidence >= 0.5) {
            // Gather context messages for reference
            let contextMsgs = [];
            try {
              const recent = await chat.fetchMessages({ limit: 8 });
              contextMsgs = recent
                .filter(m => (m.id._serialized || m.id.id) !== msgId)
                .slice(-6)
                .map(m => ({
                  sender: m.fromMe ? 'Me' : (m.author || m.from || 'Unknown'),
                  body: (m.body || '').substring(0, 300),
                  timestamp: m.timestamp ? m.timestamp * 1000 : Date.now()
                }));
            } catch { /* ok */ }

            const approvalStatus = aiResult.summary?.toLowerCase().includes('reject') ? 'rejected'
              : aiResult.summary?.toLowerCase().includes('condition') ? 'conditional'
              : 'approved';

            await this.store.addApproval({
              chatId,
              chatName,
              sender: senderName,
              body: (message.body || '').substring(0, 500),
              timestamp,
              offerSheetRef: quotedMsgBody ? quotedMsgBody.substring(0, 200) : '',
              offerDescription: aiResult.summary || '',
              status: approvalStatus,
              confidence: aiResult.confidence,
              aiSummary: aiResult.summary || '',
              conditions: '',
              sourceMessageId: null,
              msgId,
              contextMessages: contextMsgs
            });
            console.log(`[Approval] Detected ${approvalStatus} from ${senderName} in ${chatName}`);
          }
        }
      });
    }

    // Check if non-question messages answer a pending question
    if (isGroupChat && !analysis.isQuestion) {
      // Get approximate recent message count for conversation proximity signal
      let recentMsgCount = 0;
      try {
        const recentMsgs = await chat.fetchMessages({ limit: 10 });
        recentMsgCount = recentMsgs.length;
      } catch { /* ok */ }

      await this.store.checkForAnswers({
        chatId,
        sender: senderName,
        body: message.body || '',
        timestamp,
        msgId,
        quotedMsgBody,
        quotedMsgSender,
        isQuotedReply,
        isMyMessage: false,
        recentMsgCount,
        analyzer: this.analyzer
      });
    }

    if (updated || isGroupChat) {
      this.emit('data_updated');
    }
  }

  // ── Outgoing Messages ──

  async sendMessage(chatId, text, mentionIds = []) {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp not connected');
    }
    try {
      const options = {};
      if (mentionIds.length > 0) {
        const mentions = [];
        for (const mid of mentionIds) {
          try {
            const contact = await this.client.getContactById(mid);
            if (contact) mentions.push(contact);
          } catch (e) { /* skip unresolvable */ }
        }
        if (mentions.length > 0) options.mentions = mentions;
      }
      await this.client.sendMessage(chatId, text, options);
      console.log(`[SENT] Message to ${chatId}${mentionIds.length ? ` (mentions: ${mentionIds.length})` : ''}`);
      return { success: true };
    } catch (err) {
      console.error('[SEND ERR]', err.message);
      throw err;
    }
  }

  async getGroupParticipants(chatId) {
    if (!this.ready || !this.client) return [];
    try {
      const chat = await this.client.getChatById(chatId);
      if (!chat.isGroup) return [];
      const participants = chat.participants || [];
      const result = [];
      for (const p of participants) {
        const id = p.id._serialized || p.id;
        try {
          const contact = await this.client.getContactById(id);
          result.push({
            id,
            name: contact.pushname || contact.name || contact.number || id.split('@')[0],
            number: contact.number || id.split('@')[0],
            isAdmin: p.isAdmin || false
          });
        } catch {
          result.push({
            id,
            name: id.split('@')[0],
            number: id.split('@')[0],
            isAdmin: p.isAdmin || false
          });
        }
      }
      return result.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error('[PARTICIPANTS ERR]', err.message);
      return [];
    }
  }

  async sendBroadcast(chatIds, text) {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp not connected');
    }
    const results = [];
    for (const chatId of chatIds) {
      try {
        await this.client.sendMessage(chatId, text);
        results.push({ chatId, success: true });
        console.log(`[BROADCAST] Sent to ${chatId}`);
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error(`[BROADCAST ERR] ${chatId}:`, err.message);
        results.push({ chatId, success: false, error: err.message });
      }
    }
    return results;
  }

  async getChats() {
    if (!this.ready || !this.client) return [];
    try {
      const chats = await this.client.getChats();
      return chats.map(c => ({
        id: c.id._serialized,
        name: c.name || c.id.user || c.id._serialized,
        isGroup: c.isGroup,
        timestamp: c.timestamp ? c.timestamp * 1000 : 0,
        unreadCount: c.unreadCount || 0
      }));
    } catch (err) {
      console.error('[CHATS ERR]', err.message);
      return [];
    }
  }

  async getContacts() {
    if (!this.ready || !this.client) return [];
    try {
      const contacts = await this.client.getContacts();
      return contacts
        .filter(c => c.isMyContact && !c.isGroup && !c.isMe)
        .map(c => ({
          id: c.id._serialized,
          name: c.pushname || c.name || c.number || c.id.user || 'Unknown',
          number: c.number || c.id.user || ''
        }));
    } catch (err) {
      console.error('[CONTACTS ERR]', err.message);
      return [];
    }
  }

  async getConversation(chatId, limit = 50) {
    if (!this.ready || !this.client) return [];
    try {
      const chat = await this.client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit });
      const result = [];

      for (const msg of messages) {
        const entry = {
          id: msg.id._serialized || msg.id.id,
          body: msg.body || '',
          fromMe: msg.fromMe,
          timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
          type: msg.type || 'chat',
          hasMedia: msg.hasMedia || false,
          sender: 'Unknown',
          mediaData: null
        };

        try {
          if (msg.fromMe) {
            entry.sender = 'You';
          } else {
            const contact = await msg.getContact();
            entry.sender = contact.pushname || contact.name || contact.number || 'Unknown';
          }
        } catch {
          entry.sender = msg.fromMe ? 'You' : (msg.from || 'Unknown');
        }

        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              entry.mediaData = {
                mimetype: media.mimetype,
                data: media.data,
                filename: media.filename || null,
                filesize: media.filesize || null
              };
            }
          } catch (err) {
            console.error('[MEDIA DL ERR]', err.message);
            entry.mediaData = null;
          }
        }

        if (msg.type === 'location' && msg.location) {
          entry.location = {
            latitude: msg.location.latitude,
            longitude: msg.location.longitude,
            description: msg.location.description || ''
          };
        }

        if (msg.type === 'vcard' && msg.vCards) {
          entry.vCards = msg.vCards;
        }

        result.push(entry);
      }

      return result;
    } catch (err) {
      console.error('[CONVERSATION ERR]', err.message);
      return [];
    }
  }

  async sendMediaMessage(chatId, base64Data, mimetype, filename, caption) {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp not connected');
    }
    try {
      const media = new MessageMedia(mimetype, base64Data, filename);
      await this.client.sendMessage(chatId, media, {
        caption: caption || undefined
      });
      console.log(`[SENT MEDIA] ${mimetype} to ${chatId}`);
      return { success: true };
    } catch (err) {
      console.error('[SEND MEDIA ERR]', err.message);
      throw err;
    }
  }

  // ── Backfill: Pull historical messages and process as inbound ──

  /**
   * Backfill messages from all group chats.
   * Fetches history from WhatsApp, runs analyzer + AI classifier,
   * stores in DB (skipping duplicates).
   *
   * @param {object} options
   * @param {number} options.messagesPerChat - max messages to fetch per chat (default 100)
   * @param {function} options.onProgress - callback(update) for progress reporting
   * @returns {object} summary stats
   */
  async backfill({ messagesPerChat = 100, onProgress = null } = {}) {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp not connected');
    }

    const myId = await this.store.getMyId();
    const myLid = await this.store.getMyLid();
    const trackName = await this.store.getTrackName() || '';

    // Get partner group names from Settings, then match against WhatsApp chats by name
    const partnerNames = await this.store.getPartnerGroupNames();
    const partnerNamesLower = new Set(partnerNames.map(n => n.toLowerCase().trim()));

    const allChats = await this.client.getChats();
    const groupChats = allChats.filter(c => {
      if (!c.isGroup) return false;
      const name = (c.name || '').toLowerCase().trim();
      return partnerNamesLower.has(name);
    });

    console.log(`[Backfill] Matched ${groupChats.length} of ${partnerNames.length} partner groups from Settings`);
    if (groupChats.length < partnerNames.length) {
      const matchedNames = new Set(groupChats.map(c => (c.name || '').toLowerCase().trim()));
      const unmatched = partnerNames.filter(n => !matchedNames.has(n.toLowerCase().trim()));
      console.log(`[Backfill] Could not find WhatsApp chats for: ${unmatched.join(', ')}`);
    }

    const stats = {
      totalChats: groupChats.length,
      processedChats: 0,
      totalMessages: 0,
      newMessages: 0,
      skippedDuplicates: 0,
      questions: 0,
      mentions: 0,
      errors: 0,
      currentChat: ''
    };

    const report = (extra) => {
      if (onProgress) onProgress({ ...stats, ...extra });
    };

    console.log(`[Backfill] Starting — ${groupChats.length} group chats, ${messagesPerChat} msgs each`);
    report();

    for (const chat of groupChats) {
      const chatId = chat.id._serialized;
      const chatName = chat.name || chatId;
      stats.currentChat = chatName;
      report();

      try {
        // Fetch message history
        const messages = await chat.fetchMessages({ limit: messagesPerChat });
        console.log(`[Backfill] ${chatName}: fetched ${messages.length} messages`);

        // Check which msg_ids already exist in our messages table to skip dupes
        const msgIds = messages
          .map(m => m.id ? (m.id._serialized || m.id.id) : null)
          .filter(Boolean);

        const { data: existing } = await this.store.supabase
          .from('messages')
          .select('body, sender, timestamp')
          .eq('chat_id', chatId)
          .order('timestamp', { ascending: false })
          .limit(500);

        // Build a simple dedup set from existing messages (body+sender+timestamp)
        const existingSet = new Set();
        if (existing) {
          for (const row of existing) {
            existingSet.add(`${row.sender}|${row.timestamp}|${(row.body || '').substring(0, 50)}`);
          }
        }

        for (const msg of messages) {
          stats.totalMessages++;

          const timestamp = msg.timestamp ? msg.timestamp * 1000 : Date.now();
          const msgId = msg.id ? (msg.id._serialized || msg.id.id) : null;
          const hasMedia = msg.hasMedia || false;
          const mediaType = msg.type || 'chat';
          const body = msg.body || '';

          // Resolve sender name
          let senderName = 'Unknown';
          try {
            if (msg.fromMe) {
              senderName = trackName || 'Me';
            } else {
              const contact = await msg.getContact();
              senderName = contact.pushname || contact.name || contact.number || 'Unknown';
            }
          } catch {
            senderName = msg.fromMe ? (trackName || 'Me') : (msg.author || msg.from || 'Unknown');
          }

          // Dedup check
          const dupeKey = `${senderName}|${timestamp}|${body.substring(0, 50)}`;
          if (existingSet.has(dupeKey)) {
            stats.skippedDuplicates++;
            continue;
          }
          existingSet.add(dupeKey);

          // Record the group message (analytics, volume, sender stats, feed)
          try {
            await this.store.recordGroupMessage({
              chatId,
              chatName,
              sender: senderName,
              body,
              timestamp,
              hasMedia,
              mediaType
            });
            stats.newMessages++;
          } catch (err) {
            stats.errors++;
            continue;
          }

          // Skip further analysis for our own messages during backfill
          if (msg.fromMe) continue;

          // Run the analyzer (same as live inbound)
          const analysis = this.analyzer.analyze(msg, myId, myLid, true);

          // Mentions
          if (analysis.isMention) {
            try {
              await this.store.addMention({
                chatId, chatName, sender: senderName,
                body: body.substring(0, 500),
                timestamp, hasMedia, mediaType
              });
              stats.mentions++;
            } catch { /* skip */ }
          }

          // Questions
          if (analysis.isQuestion) {
            try {
              const questionId = await this.store.addQuestion({
                chatId, chatName, sender: senderName,
                body: body.substring(0, 500),
                timestamp, hasMedia, mediaType,
                msgId,
                questionAnalysis: analysis.questionAnalysis || {}
              });
              stats.questions++;

              // Queue for AI verification
              if (this.aiClassifier && questionId) {
                this.aiClassifier.queueMessage({
                  id: questionId,
                  body, sender: senderName, chatName,
                  isGroupChat: true,
                  regexResult: analysis.questionAnalysis,
                  onClassified: async (id, aiResult) => {
                    await this.store.updateQuestionAIClassification(id, aiResult);
                  }
                });
              }
            } catch { /* skip */ }
          }

          // Queue non-questions for AI (to catch missed questions)
          if (!analysis.isQuestion && this.aiClassifier && body.length >= 3) {
            this.aiClassifier.queueMessage({
              id: `bf_${msgId || Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              body, sender: senderName, chatName,
              isGroupChat: true,
              regexResult: null,
              onClassified: async (id, aiResult) => {
                if (aiResult && aiResult.intent === 'question' && aiResult.confidence >= 0.7) {
                  await this.store.promoteMessageToQuestion({
                    chat_id: chatId, chat_name: chatName,
                    sender: senderName,
                    body: body.substring(0, 500),
                    timestamp, id: msgId
                  }, aiResult);
                  stats.questions++;
                }
              }
            });
          }

          // Throttle slightly to avoid hammering contact lookups
          if (stats.totalMessages % 20 === 0) {
            await new Promise(r => setTimeout(r, 100));
            report();
          }
        }

        stats.processedChats++;
        report();
        console.log(`[Backfill] ${chatName}: done (${stats.newMessages} new so far)`);

        // Small delay between chats
        await new Promise(r => setTimeout(r, 200));

      } catch (err) {
        console.error(`[Backfill] Error on ${chatName}:`, err.message);
        stats.errors++;
        stats.processedChats++;
        report();
      }
    }

    console.log(`[Backfill] Complete — ${stats.newMessages} new messages, ${stats.questions} questions, ${stats.mentions} mentions, ${stats.skippedDuplicates} dupes skipped`);
    return stats;
  }

  isReady() {
    return this.ready;
  }

  async destroy() {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (err) {
        console.error('Error destroying client:', err);
      }
    }
  }
}

module.exports = WhatsAppService;
