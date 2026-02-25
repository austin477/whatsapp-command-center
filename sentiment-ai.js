/**
 * AI-powered sentiment analysis using a local transformer model.
 * Uses @xenova/transformers to run a distilbert-based sentiment model
 * directly in Node.js — no API key, no internet needed after first download.
 *
 * First run downloads ~67MB model, cached locally for subsequent uses.
 */

let pipeline = null;
let sentimentPipeline = null;
let modelStatus = 'idle'; // idle | loading | ready | error
let modelError = null;
let loadProgress = 0;

async function loadModel(progressCallback) {
  if (modelStatus === 'ready' && sentimentPipeline) return true;
  if (modelStatus === 'loading') return false;

  modelStatus = 'loading';
  loadProgress = 0;

  try {
    // Dynamic import so the app doesn't crash if the package isn't installed
    const { pipeline: createPipeline } = await import('@xenova/transformers');
    pipeline = createPipeline;

    sentimentPipeline = await createPipeline(
      'sentiment-analysis',
      'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
      {
        progress_callback: (data) => {
          if (data.status === 'progress' && data.total) {
            loadProgress = Math.round((data.loaded / data.total) * 100);
            if (progressCallback) progressCallback({ status: 'progress', progress: loadProgress });
          }
          if (data.status === 'done') {
            loadProgress = 100;
            if (progressCallback) progressCallback({ status: 'done', progress: 100 });
          }
        }
      }
    );

    modelStatus = 'ready';
    loadProgress = 100;
    console.log('[SentimentAI] Model loaded successfully');
    return true;
  } catch (err) {
    modelStatus = 'error';
    modelError = err.message;
    console.error('[SentimentAI] Failed to load model:', err.message);

    // Check if the package is simply not installed
    if (err.message.includes('Cannot find') || err.message.includes('MODULE_NOT_FOUND')) {
      modelError = 'Package @xenova/transformers not installed. Run: npm install @xenova/transformers';
    }

    return false;
  }
}

/**
 * Analyze sentiment of a single text using the AI model.
 * Returns { score, label, confidence } or null if model not ready.
 */
async function analyze(text) {
  if (modelStatus !== 'ready' || !sentimentPipeline) return null;
  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return { score: 0, label: 'neutral', confidence: 1.0 };
  }

  try {
    // Truncate very long messages (model has a token limit)
    const input = text.substring(0, 512);
    const result = await sentimentPipeline(input);

    if (!result || !result[0]) return null;

    const { label, score: confidence } = result[0];

    // The model returns POSITIVE/NEGATIVE with a confidence score
    // Convert to our -1 to 1 range
    let normalizedScore;
    if (label === 'POSITIVE') {
      normalizedScore = confidence; // 0.5 to 1.0
    } else {
      normalizedScore = -confidence; // -0.5 to -1.0
    }

    // Map to our label system with a neutral zone
    let ourLabel = 'neutral';
    if (normalizedScore > 0.25) ourLabel = 'positive';
    else if (normalizedScore < -0.25) ourLabel = 'negative';

    return {
      score: normalizedScore,
      label: ourLabel,
      confidence,
      magnitude: Math.abs(normalizedScore)
    };
  } catch (err) {
    console.error('[SentimentAI] Analysis error:', err.message);
    return null;
  }
}

/**
 * Batch analyze multiple texts efficiently.
 * Returns array of results in same order as input.
 */
async function analyzeBatch(texts, batchSize = 16) {
  if (modelStatus !== 'ready' || !sentimentPipeline) return texts.map(() => null);

  const results = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map(t => {
      if (!t || typeof t !== 'string' || t.trim().length < 3) return '';
      return t.substring(0, 512);
    });

    try {
      const batchResults = await Promise.all(
        batch.map(async (text) => {
          if (!text) return { score: 0, label: 'neutral', confidence: 1.0, magnitude: 0 };
          return await analyze(text);
        })
      );
      results.push(...batchResults);
    } catch (err) {
      console.error('[SentimentAI] Batch error:', err.message);
      results.push(...batch.map(() => null));
    }
  }

  return results;
}

function getStatus() {
  return {
    status: modelStatus,
    progress: loadProgress,
    error: modelError,
    ready: modelStatus === 'ready'
  };
}

function isReady() {
  return modelStatus === 'ready' && sentimentPipeline !== null;
}

module.exports = { loadModel, analyze, analyzeBatch, getStatus, isReady };
