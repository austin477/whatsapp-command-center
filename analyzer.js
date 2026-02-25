/**
 * Message Analyzer v2 — Enhanced Question & Answer Detection
 *
 * Detects mentions, classifies questions by type and priority,
 * extracts keywords, and scores answer candidates with multi-signal confidence.
 */

class Analyzer {
  constructor(trackName = '') {
    this.setTrackName(trackName);
  }

  setTrackName(name) {
    this.trackName = name;
    this.namePatterns = this._buildNamePatterns(name);
  }

  // ═══════════════════════════════════════════
  // Mention Detection
  // ═══════════════════════════════════════════

  _buildNamePatterns(fullName) {
    const patterns = [];
    if (!fullName || !fullName.trim()) return patterns;
    const escaped = this._escapeRegex(fullName);
    patterns.push(new RegExp(`\\b${escaped}\\b`, 'i'));
    const parts = fullName.trim().split(/\s+/);
    for (const part of parts) {
      if (part.length >= 3) {
        patterns.push(new RegExp(`\\b${this._escapeRegex(part)}\\b`, 'i'));
      }
    }
    return patterns;
  }

  _matchesAnyNamePattern(text) {
    for (const pattern of this.namePatterns) {
      if (pattern.test(text)) return true;
    }
    return false;
  }

  isMention(message, myId, myLid) {
    if (message.mentionedIds && message.mentionedIds.length > 0) {
      const myIds = new Set();
      if (myId) { myIds.add(myId); myIds.add(myId.split('@')[0]); }
      if (myLid) { myIds.add(myLid); myIds.add(myLid.split('@')[0]); }
      if (myIds.size > 0) {
        for (const mentionId of message.mentionedIds) {
          const mentionStr = String(mentionId);
          const mentionNumber = mentionStr.split('@')[0];
          if (myIds.has(mentionStr) || myIds.has(mentionNumber)) return true;
        }
      }
    }
    const body = message.body || '';
    if (this._matchesAnyNamePattern(body)) return true;
    if (message.hasQuotedMsg && message._data?.quotedMsg?.body) {
      if (this._matchesAnyNamePattern(message._data.quotedMsg.body)) return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════
  // Question Detection (Enhanced)
  // ═══════════════════════════════════════════

  /**
   * Returns null if not a question, or a detailed question analysis object:
   * {
   *   isQuestion: true,
   *   questionType: 'yes_no' | 'info_seeking' | 'action_request' | 'opinion' | 'status_check' | 'scheduling' | 'approval' | 'general',
   *   priority: 'low' | 'normal' | 'high' | 'urgent',
   *   keywords: string[],
   *   directedAtMe: boolean
   * }
   */
  analyzeQuestion(message, myId, myLid, isGroupChat) {
    const body = (message.body || '').trim();
    if (!body || body.length < 3) return null;

    // Skip common non-question patterns that look like questions
    if (this._isNonQuestion(body)) return null;

    const questionType = this._classifyQuestionType(body);
    if (!questionType) return null;

    const priority = this._classifyPriority(body, questionType, message, myId, myLid, isGroupChat);
    const keywords = this._extractKeywords(body);
    const directedAtMe = this._isDirectedAtMe(message, myId, myLid, isGroupChat);

    return {
      isQuestion: true,
      questionType,
      priority,
      keywords,
      directedAtMe
    };
  }

  /**
   * Filter out false-positive questions — greetings, reactions, rhetorical, etc.
   */
  _isNonQuestion(text) {
    const lower = text.toLowerCase().trim();

    // Very short — usually not real questions
    if (lower.length < 5) return true;

    // Rhetorical / reaction patterns
    const nonQuestionPatterns = [
      /^(lol|haha|😂|🤣|😅|💀|omg|wow|nice|great|awesome|cool|ok|okay)\s*\??$/i,
      /^(good morning|good afternoon|good evening|gm|ga)\s*\??$/i,
      /^(hi|hello|hey|sup|yo)\s*\??$/i,
      /^(right|ikr|i know right|same|true|facts)\s*\??$/i,
      /^(done|sorted|fixed|handled|resolved|completed|finished|sent|updated|approved|confirmed|noted|acknowledged|received|accepted|rejected|denied)\s*[.!]?$/i,
      /^(what|wut|wat)\s*\?*$/i,  // just "what??" as reaction
      /^(huh|hmm|eh|ah|oh)\s*\??$/i,
      /^(really|seriously|for real)\s*\??$/i,
      /^\?+$/,
      /^[^\w]*$/,  // only emojis or symbols
    ];

    for (const p of nonQuestionPatterns) {
      if (p.test(lower)) return true;
    }

    return false;
  }

  /**
   * Classify the type of question being asked.
   * Returns null if not a question.
   */
  _classifyQuestionType(text) {
    const lower = text.toLowerCase().trim();

    // ── Yes/No Questions ──
    const yesNoStarters = /^(is|are|was|were|do|does|did|can|could|would|should|will|shall|have|has|had|may|might|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|couldn't|wouldn't|shouldn't|won't)\b/i;
    if (yesNoStarters.test(lower) && (lower.includes('?') || lower.length < 80)) {
      return 'yes_no';
    }

    // ── Approval / Permission ──
    // Note: bare "approved", "sign off" etc. are ANSWERS, not questions.
    // Only match approval patterns when there's interrogative framing.
    const approvalPatterns = [
      /\b(approve|approved|approval|sign off|sign-off|greenlight|green light)\b.*\?/i,
      /\bcan (i|we) (go ahead|proceed|move forward|start|begin)\b/i,
      /\b(is this|does this|are we) (ok|okay|good|ready|approved)\b/i,
      /\bpermission to\b/i,
      /\b(ready to|good to) (go|send|ship|launch|submit|publish)\b.*\?/i,
    ];
    for (const p of approvalPatterns) {
      if (p.test(lower)) return 'approval';
    }

    // ── Scheduling ──
    const schedulePatterns = [
      /\b(when|what time|what day|which day)\b.*\b(meeting|call|session|standup|sync|available|free)\b/i,
      /\b(meeting|call|session|standup|sync)\b.*\b(when|what time|schedule)\b/i,
      /\bschedule\b/i,
      /\bwhat('s| is) (the|a good) time\b/i,
      /\bwhen (can|should|will|do) (we|you|i|they)\b/i,
      /\b(availability|availabilities|available)\s*\?/i,
    ];
    for (const p of schedulePatterns) {
      if (p.test(lower)) return 'scheduling';
    }

    // ── Status Check ──
    const statusPatterns = [
      /\b(status|update|progress|eta|timeline|deadline)\b.*\?/i,
      /\bwhat('s| is) the (status|update|progress|eta|plan|timeline)\b/i,
      /\b(any|got) (update|news|progress)\b/i,
      /\bhow('s| is) (it|that|the|this) (going|coming|progressing)\b/i,
      /\bwhere (are|do) (we|you|they) stand\b/i,
      /\bhow far along\b/i,
    ];
    for (const p of statusPatterns) {
      if (p.test(lower)) return 'status_check';
    }

    // ── Action Request ──
    const actionPatterns = [
      /\bcan (you|someone|anyone|anybody|we)\b.*\b(send|do|make|create|check|look|handle|fix|update|share|forward|upload|post|add|remove|set up)\b/i,
      /\bcould (you|someone|anyone)\b/i,
      /\bwould (you|someone) (mind|be able to|please)\b/i,
      /\bplease\b.*\b(send|do|make|create|check|look|handle|fix|update|share)\b/i,
      /\bneed (you|someone|help) to\b/i,
      /\b(who|which one of you) (can|will|is going to)\b/i,
    ];
    for (const p of actionPatterns) {
      if (p.test(lower)) return 'action_request';
    }

    // ── Opinion ──
    const opinionPatterns = [
      /\bwhat do (you|you all|y'all|everyone|we) think\b/i,
      /\bthoughts\s*\?/i,
      /\bwdyt\b/i,
      /\bopinion(s)?\s*\?/i,
      /\bfeedback\s*\?/i,
      /\bwhat('s| is) your (take|view|opinion|thought)\b/i,
      /\b(good|bad|better|best|right|wrong) (idea|approach|way|option|choice)\s*\?/i,
      /\b(should|shall) (we|i)\b/i,
      /\b(prefer|preference)\b.*\?/i,
    ];
    for (const p of opinionPatterns) {
      if (p.test(lower)) return 'opinion';
    }

    // ── Info Seeking (wh- questions) ──
    const infoPatterns = [
      /^(who|what|where|when|why|how|which|whose|whom)\b/i,
      /\b(who|what|where|when|why|how|which)\b.*\?$/i,
    ];
    for (const p of infoPatterns) {
      if (p.test(lower)) return 'info_seeking';
    }

    // ── Generic question mark ──
    if (lower.endsWith('?')) return 'general';

    // ── Implicit question patterns ──
    const implicitPatterns = [
      /\bany\s*(one|body)\s*(know|here|available|free)\b/i,
      /\bany idea(s)?\b/i,
      /\bdo you have\b/i,
      /\bhave you\b/i,
      /\bis there\b/i,
      /\bwondering (if|about|whether)\b/i,
      /\bcurious (if|about|whether)\b/i,
    ];
    for (const p of implicitPatterns) {
      if (p.test(lower)) return 'general';
    }

    return null;
  }

  /**
   * Classify priority of a question based on content, type, and context.
   */
  _classifyPriority(text, questionType, message, myId, myLid, isGroupChat) {
    const lower = text.toLowerCase();
    let score = 0;

    // Urgent keywords
    const urgentWords = /\b(urgent|asap|emergency|critical|immediately|right now|time sensitive|deadline today|eod|end of day|blocker|blocking|stuck)\b/i;
    if (urgentWords.test(lower)) score += 3;

    // High priority keywords
    const highWords = /\b(important|priority|needed|required|must|deadline|by (today|tomorrow|monday|tuesday|wednesday|thursday|friday)|client|customer|partner|escalat)\b/i;
    if (highWords.test(lower)) score += 2;

    // Directed at me — higher priority
    if (this._isDirectedAtMe(message, myId, myLid, isGroupChat)) score += 1;

    // Approval questions are inherently higher priority
    if (questionType === 'approval') score += 1;

    // Action requests tend to be important
    if (questionType === 'action_request') score += 0.5;

    // Status checks from others are moderate
    if (questionType === 'status_check') score += 0.5;

    // Low priority indicators
    const lowWords = /\b(just wondering|just curious|no rush|whenever|no hurry|low priority|not urgent|fyi|btw)\b/i;
    if (lowWords.test(lower)) score -= 2;

    if (score >= 3) return 'urgent';
    if (score >= 2) return 'high';
    if (score <= -1) return 'low';
    return 'normal';
  }

  /**
   * Check if a question is directed at the tracked user.
   */
  _isDirectedAtMe(message, myId, myLid, isGroupChat) {
    if (!isGroupChat) return true;
    return this.isMention(message, myId, myLid);
  }

  /**
   * Extract meaningful keywords from a question for matching answers.
   */
  _extractKeywords(text) {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'must',
      'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
      'my', 'your', 'his', 'its', 'our', 'their',
      'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
      'when', 'where', 'why', 'how',
      'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
      'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'about', 'into',
      'if', 'then', 'than', 'too', 'very', 'just', 'also', 'any', 'all', 'no', 'yes',
      'up', 'out', 'there', 'here', 'now', 'get', 'got', 'still', 'some',
      'please', 'thanks', 'thank', 'know', 'think', 'anyone', 'someone', 'anybody',
      'everybody', 'everyone', 'something', 'anything', 'nothing'
    ]);

    return (text || '').toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
      .filter((w, i, arr) => arr.indexOf(w) === i)  // dedupe
      .slice(0, 15);
  }

  // ═══════════════════════════════════════════
  // Answer Scoring (Enhanced Multi-Signal)
  // ═══════════════════════════════════════════

  /**
   * Score how likely a message is an answer to a specific question.
   * Returns { confidence: 0-1, signals: { ... } }
   */
  scoreAnswer(question, candidateMsg, {
    isQuotedReply = false,
    quotedMsgBody = null,
    quotedMsgSender = null,
    isFromMe = false,
    timeDeltaMs = 0,
    recentMsgCount = 0
  } = {}) {
    const signals = {};
    let totalScore = 0;

    const qBody = (question.body || '').toLowerCase().trim();
    const aBody = (candidateMsg.body || '').toLowerCase().trim();

    if (!aBody || aBody.length < 1) return { confidence: 0, signals };

    // ── Signal 1: Direct Quoted Reply (strongest signal) ──
    if (isQuotedReply && quotedMsgBody) {
      const quotedLower = quotedMsgBody.toLowerCase().trim();
      // Check if the quoted message IS the question
      const similarity = this._textSimilarity(quotedLower, qBody);
      if (similarity > 0.7) {
        signals.quoted_reply = { score: 1.0, detail: `quoted reply (similarity: ${similarity.toFixed(2)})` };
        totalScore += 1.0;
      } else if (quotedMsgSender === question.sender && similarity > 0.3) {
        signals.quoted_reply = { score: 0.8, detail: 'quoted same sender, partial match' };
        totalScore += 0.8;
      }
    }

    // ── Signal 2: Answer Pattern Detection ──
    const patternScore = this._getAnswerPatternScore(aBody, question.questionType);
    if (patternScore > 0) {
      signals.answer_pattern = { score: patternScore, detail: this._getAnswerPatternDetail(aBody, question.questionType) };
      totalScore += patternScore * 0.4;
    }

    // ── Signal 3: Keyword Overlap ──
    const questionKeywords = question.keywords || this._extractKeywords(qBody);
    const answerKeywords = this._extractKeywords(aBody);
    const overlap = this._keywordOverlapScore(questionKeywords, answerKeywords);
    if (overlap > 0) {
      signals.keyword_overlap = { score: overlap, detail: `${Math.round(overlap * 100)}% keyword overlap` };
      totalScore += overlap * 0.25;
    }

    // ── Signal 4: Addresses the question asker by name ──
    if (question.sender) {
      const askerParts = question.sender.toLowerCase().split(/\s+/);
      const addressed = askerParts.some(part => part.length >= 3 && aBody.includes(part));
      if (addressed) {
        signals.addresses_asker = { score: 0.3, detail: `mentions ${question.sender}` };
        totalScore += 0.3;
      }
    }

    // ── Signal 5: Time Proximity ──
    const minutesApart = Math.abs(timeDeltaMs) / 60000;
    if (minutesApart <= 2) {
      signals.time_proximity = { score: 0.2, detail: 'within 2 minutes' };
      totalScore += 0.2;
    } else if (minutesApart <= 10) {
      signals.time_proximity = { score: 0.15, detail: 'within 10 minutes' };
      totalScore += 0.15;
    } else if (minutesApart <= 60) {
      signals.time_proximity = { score: 0.08, detail: 'within 1 hour' };
      totalScore += 0.08;
    } else if (minutesApart > 240) {
      // Very old — penalize
      signals.time_proximity = { score: -0.1, detail: 'over 4 hours old' };
      totalScore -= 0.1;
    }

    // ── Signal 6: Conversation proximity (few messages between Q and A) ──
    if (recentMsgCount <= 2) {
      signals.conversation_proximity = { score: 0.15, detail: `${recentMsgCount} messages between` };
      totalScore += 0.15;
    } else if (recentMsgCount <= 5) {
      signals.conversation_proximity = { score: 0.08, detail: `${recentMsgCount} messages between` };
      totalScore += 0.08;
    }

    // ── Signal 7: Self-reply penalty ──
    if (candidateMsg.sender === question.sender) {
      signals.self_reply = { score: -0.5, detail: 'same person as asker' };
      totalScore *= 0.3;
    }

    // ── Signal 8: Manager's own reply boost ──
    if (isFromMe && candidateMsg.sender !== question.sender) {
      signals.manager_reply = { score: 0.25, detail: 'your reply to someone else\'s question' };
      totalScore += 0.25;
    }

    // ── Signal 9: Response length adequacy ──
    if (aBody.length > 100) {
      signals.substantive_reply = { score: 0.15, detail: 'detailed response' };
      totalScore += 0.15;
    } else if (aBody.length > 30) {
      signals.substantive_reply = { score: 0.05, detail: 'moderate response' };
      totalScore += 0.05;
    }

    // ── Signal 10: Question-type-specific answer matching ──
    const typeScore = this._questionTypeAnswerMatch(question.questionType, aBody);
    if (typeScore > 0) {
      signals.type_match = { score: typeScore, detail: `matches ${question.questionType} answer pattern` };
      totalScore += typeScore * 0.2;
    }

    const confidence = Math.max(0, Math.min(1, totalScore));
    return { confidence: Math.round(confidence * 100) / 100, signals };
  }

  /**
   * Improved answer pattern scoring
   */
  _getAnswerPatternScore(text, questionType) {
    let score = 0;

    const strongPatterns = [
      /^(yes|yeah|yep|yup|ya|yea|sure|correct|exactly|absolutely|definitely|of course|right)\b/,
      /^(no|nope|nah|not really|unfortunately|sadly|afraid not|negative)\b/,
      /^(done|sorted|fixed|handled|resolved|completed|finished|sent|updated|approved)\b/,
      /\b(i('ll|'ll| will| can)|we('ll|'ll| will| can)|let me|i('m|'m| am) on it)\b/,
      /\b(here you go|here it is|see attached|check this|take a look|see below)\b/,
      /\b(the answer is|it('s|'s| is)|they('re|'re| are)|that('s|'s| is))\b/,
      /^@?\w+\s+(yes|no|it|the|that|here|done|i)\b/,
    ];

    const mediumPatterns = [
      /\bhttps?:\/\/\S+\b/,
      /\b\d{1,2}[:.]\d{2}\b/,
      /\b\d+\s*(pm|am|hrs?|hours?|mins?|minutes?|days?|weeks?)\b/i,
      /\b(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\b(because|since|the reason|due to)\b/i,
      /\b(try|use|go to|click|open|check|look at)\b/i,
      /\b(attached|uploading|sending|forwarding)\b/i,
    ];

    const weakPatterns = [
      /\b(ok|okay|sure thing|will do|got it|noted|thanks|thank you|understood|acknowledged)\b/i,
      /\b(i think|maybe|probably|possibly|perhaps|likely)\b/i,
    ];

    const antiPatterns = [
      /^(lol|haha|😂|🤣|😅|💀)/i,
      /^(good morning|good afternoon|good evening|hi|hello|hey)\b/i,
      /^\?+$/,
      /^(same|me too|i agree)\s*$/i,
    ];

    for (const p of antiPatterns) {
      if (p.test(text)) return 0;
    }

    for (const p of strongPatterns) {
      if (p.test(text)) { score = Math.max(score, 0.85); break; }
    }
    if (score < 0.85) {
      for (const p of mediumPatterns) {
        if (p.test(text)) { score = Math.max(score, 0.5); break; }
      }
    }
    if (score < 0.5) {
      for (const p of weakPatterns) {
        if (p.test(text)) { score = Math.max(score, 0.3); break; }
      }
    }

    if (text.length > 100) score = Math.max(score, 0.4);
    else if (text.length > 50) score = Math.max(score, 0.25);

    return Math.min(score, 1);
  }

  _getAnswerPatternDetail(text, questionType) {
    if (/^(yes|yeah|yep|sure|correct|absolutely|definitely)\b/i.test(text)) return 'affirmative response';
    if (/^(no|nope|nah|not really|unfortunately)\b/i.test(text)) return 'negative response';
    if (/^(done|sorted|fixed|handled|resolved|completed)\b/i.test(text)) return 'task completion';
    if (/\bhttps?:\/\//i.test(text)) return 'contains link';
    if (/\b(attached|uploading|sending)\b/i.test(text)) return 'sharing resource';
    return 'answer-like pattern';
  }

  /**
   * Question-type-specific answer matching
   */
  _questionTypeAnswerMatch(questionType, answerText) {
    const lower = answerText.toLowerCase();

    switch (questionType) {
      case 'yes_no':
        if (/^(yes|yeah|yep|yup|sure|correct|no|nope|nah|not really)\b/i.test(lower)) return 0.9;
        if (/\b(yes|no|correct|incorrect|right|wrong)\b/i.test(lower)) return 0.5;
        return 0;

      case 'approval':
        if (/\b(approved|approve|go ahead|lgtm|looks good|green light|sign off|rejected|denied)\b/i.test(lower)) return 0.95;
        if (/\b(yes|sure|ok|no|hold off|wait|not yet)\b/i.test(lower)) return 0.6;
        return 0;

      case 'scheduling':
        if (/\b\d{1,2}[:.]\d{2}\b/.test(lower)) return 0.8;
        if (/\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|pm|am)\b/i.test(lower)) return 0.7;
        if (/\b(works for me|i'm free|available|busy|can't make it)\b/i.test(lower)) return 0.6;
        return 0;

      case 'status_check':
        if (/\b(done|complete|in progress|working on|almost|nearly|started|not started|blocked)\b/i.test(lower)) return 0.8;
        if (/\b(eta|expected|should be|will be|by)\b/i.test(lower)) return 0.5;
        return 0;

      case 'action_request':
        if (/\b(done|on it|will do|i'll|i can|sending|sent|shared|handling)\b/i.test(lower)) return 0.8;
        if (/\b(i can't|unable|not possible|someone else)\b/i.test(lower)) return 0.6;
        return 0;

      case 'info_seeking':
        if (lower.length > 30) return 0.3;  // substantive replies likely informational
        return 0;

      case 'opinion':
        if (/\b(i think|in my opinion|imo|i'd say|i prefer|i suggest|i recommend)\b/i.test(lower)) return 0.8;
        if (/\b(agree|disagree|option|better|worse|prefer)\b/i.test(lower)) return 0.5;
        return 0;

      default:
        return 0;
    }
  }

  /**
   * Keyword overlap between question keywords and answer text
   */
  _keywordOverlapScore(questionKeywords, answerKeywords) {
    if (!questionKeywords.length || !answerKeywords.length) return 0;
    const qSet = new Set(questionKeywords);
    let matches = 0;
    for (const w of answerKeywords) {
      if (qSet.has(w)) matches++;
    }
    return matches / qSet.size;
  }

  /**
   * Simple text similarity using character n-gram overlap (no ML needed)
   */
  _textSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    // Normalize
    a = a.toLowerCase().replace(/\s+/g, ' ').trim();
    b = b.toLowerCase().replace(/\s+/g, ' ').trim();

    // Short text — use substring check
    if (a.length < 20 || b.length < 20) {
      if (a.includes(b) || b.includes(a)) return 0.9;
    }

    // 3-gram overlap
    const ngramSize = 3;
    const getNgrams = (str) => {
      const grams = new Set();
      for (let i = 0; i <= str.length - ngramSize; i++) {
        grams.add(str.substring(i, i + ngramSize));
      }
      return grams;
    };

    const aGrams = getNgrams(a);
    const bGrams = getNgrams(b);
    if (aGrams.size === 0 || bGrams.size === 0) return 0;

    let intersection = 0;
    for (const gram of aGrams) {
      if (bGrams.has(gram)) intersection++;
    }

    const union = aGrams.size + bGrams.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  // ═══════════════════════════════════════════
  // Main Analyze Method
  // ═══════════════════════════════════════════

  analyze(message, myId, myLid, isGroupChat) {
    const result = {
      isMention: false,
      isQuestion: false,
      isDirectedQuestion: false,
      isDirectMessage: false,
      questionAnalysis: null  // detailed question info when isQuestion is true
    };

    if (message.fromMe) return result;

    result.isMention = this.isMention(message, myId, myLid);
    result.isDirectMessage = !isGroupChat;

    const qa = this.analyzeQuestion(message, myId, myLid, isGroupChat);
    if (qa) {
      result.isQuestion = true;
      result.isDirectedQuestion = qa.directedAtMe;
      result.questionAnalysis = qa;
    }

    return result;
  }

  _escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = Analyzer;
