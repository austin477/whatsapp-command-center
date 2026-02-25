/**
 * AI Message Classifier — Uses Claude Haiku for intelligent message classification
 *
 * Replaces brittle regex patterns with LLM-powered understanding.
 * Runs asynchronously after messages are stored, then updates DB records.
 *
 * Architecture:
 *   1. Message arrives → regex analyzer runs instantly (free, fast fallback)
 *   2. Message stored in DB with regex classification
 *   3. AI classifier runs async → updates DB with accurate classification
 *   4. If API fails, regex result stands (graceful degradation)
 *
 * Zero external dependencies — uses Node.js built-in https module.
 */

const https = require('https');

class AIClassifier {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    this.model = options.model || 'claude-haiku-4-5-20251001';
    this.enabled = !!this.apiKey;
    this.queue = [];
    this.processing = false;
    this.batchSize = 10;       // Pack more messages per API call to use fewer requests
    this.batchDelayMs = 3000;  // Wait 3s to collect a batch
    this.batchTimer = null;
    this.stats = { classified: 0, errors: 0, apiCalls: 0 };

    // Rate limiting — Anthropic free tier is 5 req/min
    this.rateLimitDelayMs = 13000;  // ~4.6 req/min to stay safely under 5/min
    this.lastRequestTime = 0;
    this.maxRetries = 3;
    this.retryBaseDelayMs = 15000;  // Start with 15s on rate limit, then exponential backoff

    if (this.enabled) {
      console.log('[AI Classifier] Initialized with model:', this.model);
      console.log('[AI Classifier] Rate limit: 1 request every', this.rateLimitDelayMs / 1000, 's');
    } else {
      console.log('[AI Classifier] No ANTHROPIC_API_KEY — running in regex-only mode');
    }
  }

  /**
   * Queue a message for AI classification.
   * Returns immediately — classification happens in background.
   */
  queueMessage({ id, body, sender, chatName, isGroupChat, regexResult, onClassified }) {
    if (!this.enabled) return;
    if (!body || body.trim().length < 3) return;

    this.queue.push({ id, body, sender, chatName, isGroupChat, regexResult, onClassified });

    // Start batch timer if not already running
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this._processBatch();
      }, this.batchDelayMs);
    }

    // If queue is full, process immediately
    if (this.queue.length >= this.batchSize) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
      this._processBatch();
    }
  }

  /**
   * Classify a single message immediately (for on-demand reclassification).
   */
  async classifyOne(body, { sender = 'Unknown', chatName = 'Unknown', isGroupChat = true } = {}) {
    if (!this.enabled) return null;
    const results = await this._callAPI([{ body, sender, chatName, isGroupChat }]);
    return results?.[0] || null;
  }

  /**
   * Classify a batch of messages (for bulk reclassification of historical data).
   */
  async classifyBatch(messages) {
    if (!this.enabled) return [];
    const results = [];

    // Process in chunks of batchSize
    for (let i = 0; i < messages.length; i += this.batchSize) {
      const chunk = messages.slice(i, i + this.batchSize);
      const chunkResults = await this._callAPI(chunk);
      results.push(...chunkResults);

      // Respect rate limit between chunks
      if (i + this.batchSize < messages.length) {
        await this._waitForRateLimit();
      }
    }

    return results;
  }

  /**
   * Wait until enough time has passed since the last request to stay under rate limits.
   */
  async _waitForRateLimit() {
    const elapsed = Date.now() - this.lastRequestTime;
    const waitMs = this.rateLimitDelayMs - elapsed;
    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  // ── Internal Methods ──

  async _processBatch() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const batch = this.queue.splice(0, this.batchSize);

    try {
      const results = await this._callAPI(batch);

      // Call back with results
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const result = results[i];
        if (result && item.onClassified) {
          try {
            await item.onClassified(item.id, result);
            this.stats.classified++;
          } catch (err) {
            console.error('[AI Classifier] Callback error:', err.message);
          }
        }
      }
    } catch (err) {
      console.error('[AI Classifier] Batch error:', err.message);
      this.stats.errors++;
    }

    this.processing = false;

    // Process next batch if queue has items — respect rate limit
    if (this.queue.length > 0) {
      const elapsed = Date.now() - this.lastRequestTime;
      const waitMs = Math.max(200, this.rateLimitDelayMs - elapsed);
      setTimeout(() => this._processBatch(), waitMs);
    }
  }

  /**
   * Call the Anthropic Messages API directly via HTTPS.
   * Includes rate limiting and retry with exponential backoff.
   */
  async _callAPI(messages) {
    if (!this.apiKey || messages.length === 0) return [];

    // Wait for rate limit before sending
    await this._waitForRateLimit();

    this.stats.apiCalls++;

    const messageList = messages.map((m, i) =>
      `[${i + 1}] "${m.body}" — from ${m.sender} in ${m.isGroupChat ? 'group' : 'DM'} "${m.chatName}"`
    ).join('\n');

    const requestBody = JSON.stringify({
      model: this.model,
      max_tokens: 1024,
      system: `You classify WhatsApp messages for a business team managing partner groups. Respond ONLY with a JSON array — no markdown, no explanation.

For each message, return an object with:
- "intent": one of "question", "answer", "request", "status_update", "approval", "fyi", "greeting", "reaction", "other"
- "question_type": (only if intent=question) one of "yes_no", "info_seeking", "action_request", "opinion", "status_check", "scheduling", "approval", "general"
- "priority": "low", "normal", "high", or "urgent"
- "confidence": 0.0-1.0 how confident you are
- "is_actionable": boolean — does this need someone to do something?
- "summary": 3-6 word summary of what the message is about

Context: These are work messages in WhatsApp groups. The team needs to know what requires action vs. what's informational.`,
      messages: [{
        role: 'user',
        content: `Classify these ${messages.length} message(s):\n\n${messageList}`
      }]
    });

    // Retry loop with exponential backoff
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this.lastRequestTime = Date.now();
        const { statusCode, body: responseText } = await this._httpsPost(requestBody);

        // Handle rate limiting (429)
        if (statusCode === 429) {
          const retryAfter = this._parseRetryAfter(responseText);
          const backoffMs = retryAfter || (this.retryBaseDelayMs * Math.pow(2, attempt));
          console.warn(`[AI Classifier] Rate limited (429). Retry ${attempt + 1}/${this.maxRetries} in ${Math.round(backoffMs / 1000)}s`);

          if (attempt < this.maxRetries) {
            await new Promise(r => setTimeout(r, backoffMs));
            this.lastRequestTime = Date.now();
            continue;
          }
          // Out of retries
          this.stats.errors++;
          console.error('[AI Classifier] Rate limit — max retries exhausted. Skipping batch.');
          return messages.map(() => null);
        }

        // Handle overloaded (529)
        if (statusCode === 529) {
          const backoffMs = this.retryBaseDelayMs * Math.pow(2, attempt);
          console.warn(`[AI Classifier] API overloaded (529). Retry ${attempt + 1}/${this.maxRetries} in ${Math.round(backoffMs / 1000)}s`);

          if (attempt < this.maxRetries) {
            await new Promise(r => setTimeout(r, backoffMs));
            continue;
          }
          this.stats.errors++;
          return messages.map(() => null);
        }

        // Handle other non-2xx errors
        if (statusCode < 200 || statusCode >= 300) {
          throw new Error(`HTTP ${statusCode}: ${responseText.substring(0, 200)}`);
        }

        // Parse successful response
        const responseJSON = JSON.parse(responseText);

        if (responseJSON.error) {
          throw new Error(responseJSON.error.message || 'API error');
        }

        const text = responseJSON.content?.[0]?.text || '[]';
        // Parse JSON — handle potential markdown wrapping
        const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsed = JSON.parse(jsonStr);

        // Ensure we have an array
        if (!Array.isArray(parsed)) return messages.map(() => null);

        return parsed.map((r) => {
          if (!r || typeof r !== 'object') return null;
          return {
            intent: r.intent || 'other',
            questionType: r.question_type || null,
            priority: r.priority || 'normal',
            confidence: Math.min(1, Math.max(0, r.confidence || 0.5)),
            isActionable: !!r.is_actionable,
            summary: r.summary || '',
            classifiedBy: 'ai'
          };
        });

      } catch (err) {
        console.error(`[AI Classifier] API error (attempt ${attempt + 1}):`, err.message);

        if (attempt < this.maxRetries) {
          const backoffMs = this.retryBaseDelayMs * Math.pow(2, attempt);
          console.log(`[AI Classifier] Retrying in ${Math.round(backoffMs / 1000)}s...`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }

        this.stats.errors++;
        return messages.map(() => null);
      }
    }

    return messages.map(() => null);
  }

  /**
   * Parse retry-after from the 429 response body (Anthropic sends it in the error JSON).
   * Returns milliseconds to wait, or null if not found.
   */
  _parseRetryAfter(responseText) {
    try {
      const json = JSON.parse(responseText);
      // Anthropic sometimes includes retry info in error message
      const msg = json?.error?.message || '';
      const match = msg.match(/try again in (\d+\.?\d*)\s*s/i);
      if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 1000; // Add 1s buffer
    } catch (e) { /* ignore parse errors */ }
    return null;
  }

  /**
   * Raw HTTPS POST to the Anthropic Messages API.
   * Returns { statusCode, body } so the caller can handle 429/529 specifically.
   * No external dependencies needed.
   */
  _httpsPost(body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      req.write(body);
      req.end();
    });
  }

  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      model: this.model,
      queueLength: this.queue.length
    };
  }
}

module.exports = AIClassifier;
