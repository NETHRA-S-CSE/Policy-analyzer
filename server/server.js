const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const multer = require("multer");
const mammoth = require("mammoth");
const { IndexFlatIP } = require("faiss-node");

if (typeof global.DOMMatrix === "undefined") {
  global.DOMMatrix = class DOMMatrix {};
}

if (typeof global.ImageData === "undefined") {
  global.ImageData = class ImageData {};
}

if (typeof global.Path2D === "undefined") {
  global.Path2D = class Path2D {};
}

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 5000;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_EMBEDDING_API_URL = "https://openrouter.ai/api/v1/embeddings";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_EMBEDDING_MODEL = process.env.OPENROUTER_EMBEDDING_MODEL || "openai/text-embedding-3-small";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || "http://localhost:5173";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "Company Policy RAG Assistant";

function hasValidOpenRouterKey() {
  const key = String(process.env.OPENROUTER_API_KEY || "").trim().replace(/^"|"$/g, "");
  if (!key) {
    return false;
  }

  const invalidPlaceholders = new Set(["api", "your_api_key", "openrouter_api_key", "changeme"]);
  return !invalidPlaceholders.has(key.toLowerCase());
}

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

const defaultPolicyText = `
1. Code of Conduct

All employees are expected to maintain professionalism, integrity, and respect in the workplace.

Harassment, discrimination, or bullying of any kind will not be tolerated.
Employees must follow ethical practices when handling company data and interacting with clients.
Any violation of conduct policies may result in disciplinary action, including termination.
2. Work Hours & Attendance
Standard working hours are 9:00 AM to 6:00 PM, Monday to Friday.
Employees are allowed flexible work arrangements with prior manager approval.
Late arrivals exceeding 3 instances per month will be flagged for review.
Employees must log attendance using the internal system daily.
3. Remote Work Policy
Employees may work remotely up to 3 days per week.
Mandatory availability during core hours: 11:00 AM – 4:00 PM.
Employees must ensure a stable internet connection and secure workspace.
Confidential company data must not be accessed over public networks.
4. Leave Policy
Annual Leave: 20 days per year
Sick Leave: 10 days per year
Casual Leave: 5 days per year

Rules:

Leave requests must be submitted at least 2 days in advance (except emergencies).
Sick leave exceeding 3 days requires medical documentation.
Unused leaves cannot be carried forward beyond one year.
5. Data Security Policy
Employees must not share passwords or access credentials.
Sensitive data must be encrypted before external transmission.
Use of unauthorized USB devices is strictly prohibited.
All company devices must have updated antivirus software.
6. IT Usage Policy
Company systems are to be used for work purposes only.
Downloading pirated or unauthorized software is prohibited.
Email communication must follow official etiquette and security guidelines.
Suspicious emails must be reported to the IT department immediately.
7. Confidentiality Agreement
Employees must not disclose confidential information during or after employment.
Confidential data includes:
Client information
Financial records
Internal project details
Violation may lead to legal action.
8. Performance Evaluation
Employees are evaluated twice a year.
Metrics include:
Productivity
Team collaboration
Quality of work
Continuous feedback is encouraged through monthly check-ins.
9. Disciplinary Actions
Minor violations: Warning notice
Repeated violations: Suspension
Severe violations: Termination

All disciplinary actions will be documented and reviewed by HR.

10. Health & Safety Policy
Employees must follow workplace safety guidelines.
Emergency exits and procedures must be understood by all employees.
Any accidents must be reported immediately
`;

let currentPolicyText = normalizeExtractedPolicyText(defaultPolicyText);
let currentPolicySource = "Default company policy";
let currentPolicyChunks = [];
let faissIndex = null;
let vectorChunkLookup = [];
let vectorSearchReady = false;
let embeddingProvider = "auto";
let embeddingFallbackLogged = false;
const LOCAL_EMBEDDING_DIMENSION = 384;
const STOP_WORDS = new Set([
  "how",
  "explain",
  "many",
  "what",
  "when",
  "where",
  "which",
  "for",
  "the",
  "are",
  "is",
  "can",
  "days",
  "day",
  "leave",
  "policy",
  "employee",
  "employees",
  "from",
  "into",
  "with",
  "that",
  "this",
  "allowed",
  "allow",
  "available",
  "availability",
  "give",
  "given",
  "gives",
  "approve",
  "approved",
  "approves",
  "please",
  "tell",
  "about",
]);

function getFocusTokens(question) {
  const normalized = question.toLowerCase();
  const tokens = normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);

  const focusTokens = tokens.filter((token) => !STOP_WORDS.has(token));

  if (/(work\s*from\s*home|wfh|remote\s*work|remote)/i.test(normalized)) {
    // For WFH intent, only keep explicit WFH signals to avoid noisy matches like "available".
    return ["wfh", "remote", "home"];
  }

  return Array.from(new Set(focusTokens));
}

function getKeyQuestionTokens(question) {
  return getFocusTokens(question).filter((token) => token.length > 3);
}

function normalizeToken(token) {
  const t = String(token || "").toLowerCase();
  if (t.endsWith("ing") && t.length > 5) {
    return t.slice(0, -3);
  }
  if (t.endsWith("ed") && t.length > 4) {
    return t.slice(0, -2);
  }
  if (t.endsWith("es") && t.length > 4) {
    return t.slice(0, -2);
  }
  if (t.endsWith("s") && t.length > 4) {
    return t.slice(0, -1);
  }
  return t;
}

function tokenMatchesAnswer(token, answerText) {
  const normalized = normalizeToken(token);
  const variants = Array.from(new Set([token.toLowerCase(), normalized])).filter(Boolean);

  return variants.some((variant) => {
    if (variant.length < 3) {
      return false;
    }
    return new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\w*\\b`, "i").test(answerText);
  });
}

function normalizePolicyLine(line) {
  return line
    .replace(/^[\s\-\*•\u2022\u25CF\u25E6\t]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeExtractedPolicyText(text) {
  const cleaned = String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\u0000/g, "")
    .trim();

  // Join likely hard-wrapped PDF lines, but keep headings/list structure as much as possible.
  return cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([a-z0-9,;])\n(?=[a-z(])/g, "$1 ")
    .replace(/\n[\s\-\*•\u2022\u25CF\u25E6]+/g, "\n")
    .trim();
}

function completeTruncatedAnswer(answer, chunks) {
  const value = String(answer || "").trim();
  if (!value || value.includes("\n") || value === "Not mentioned in policy.") {
    return value;
  }

  const looksIncomplete =
    /\b(of|for|to|from|by|with|in|on|at|as|and|or|but|that|which|who|whom|whose)\s*$/i.test(value) ||
    (!/[.!?]$/.test(value) && value.split(/\s+/).length >= 6);

  if (!looksIncomplete) {
    return value;
  }

  const corpus = chunks.join(" ").replace(/\s+/g, " ").trim();
  const idx = corpus.toLowerCase().indexOf(value.toLowerCase());
  if (idx < 0) {
    return value;
  }

  const remainder = corpus.slice(idx + value.length).trimStart();
  if (!remainder) {
    return value;
  }

  const sentenceEnd = remainder.search(/[.!?](\s|$)/);
  if (sentenceEnd < 0) {
    return value;
  }

  const extension = remainder.slice(0, sentenceEnd + 1).trim();
  if (!extension) {
    return value;
  }

  return `${value} ${extension}`.replace(/\s+/g, " ").trim();
}

function hasWord(text, token) {
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function isRuleLikeSnippet(snippet) {
  const normalized = snippet.toLowerCase();
  if (snippet.length < 20) {
    return false;
  }
  return /\b(must|may|should|required|allowed|eligible|prohibited|cannot|not|are|is)\b|\d/.test(normalized);
}

function isHeadingLikeSnippet(snippet) {
  const cleaned = String(snippet || "").trim();
  if (!cleaned) {
    return true;
  }

  if (/^[\d]+\./.test(cleaned)) {
    return true;
  }

  if (cleaned.split(/\s+/).length <= 4 && !/\d/.test(cleaned) && !/[.!?]/.test(cleaned)) {
    const hasActionVerb = /\b(is|are|was|were|must|may|should|can|will|requires?|includes?)\b/i.test(cleaned);
    return !hasActionVerb;
  }

  return false;
}

function chunkPolicyText(text, maxWordsPerChunk = 500) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks = [];
  let currentChunk = "";
  let currentWordCount = 0;

  const flushChunk = () => {
    if (currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = "";
      currentWordCount = 0;
    }
  };

  const addUnit = (unitText) => {
    const unitWordCount = unitText.split(/\s+/).length;
    if (currentWordCount + unitWordCount > maxWordsPerChunk && currentChunk) {
      flushChunk();
    }
    currentChunk += (currentChunk ? " " : "") + unitText;
    currentWordCount += unitWordCount;
  };

  for (const paragraph of paragraphs) {
    const paragraphWordCount = paragraph.split(/\s+/).length;

    if (paragraphWordCount <= maxWordsPerChunk) {
      if (currentWordCount + paragraphWordCount > maxWordsPerChunk && currentChunk) {
        flushChunk();
      }
      currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
      currentWordCount += paragraphWordCount;
    } else {
      // Oversized paragraphs are split into sentence units to keep chunk size bounded.
      const sentenceUnits = paragraph
        .split(/(?<=[.!?])\s+/)
        .map((unit) => unit.trim())
        .filter(Boolean);

      if (sentenceUnits.length === 0) {
        const words = paragraph.split(/\s+/);
        for (let i = 0; i < words.length; i += maxWordsPerChunk) {
          addUnit(words.slice(i, i + maxWordsPerChunk).join(" "));
          flushChunk();
        }
        continue;
      }

      for (const unit of sentenceUnits) {
        const unitWordCount = unit.split(/\s+/).length;
        if (unitWordCount > maxWordsPerChunk) {
          const words = unit.split(/\s+/);
          for (let i = 0; i < words.length; i += maxWordsPerChunk) {
            addUnit(words.slice(i, i + maxWordsPerChunk).join(" "));
            flushChunk();
          }
        } else {
          addUnit(unit);
        }
      }

      flushChunk();
    }
  }

  flushChunk();

  return chunks;
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

function buildLocalEmbedding(text, dimension = LOCAL_EMBEDDING_DIMENSION) {
  const vec = new Array(dimension).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    const idx = Math.abs(hash) % dimension;
    vec[idx] += 1;
  }

  return normalizeVector(vec);
}

async function getTextEmbedding(text) {
  if (!hasValidOpenRouterKey() || embeddingProvider === "local") {
    return buildLocalEmbedding(text);
  }

  try {
    const response = await fetch(OPENROUTER_EMBEDDING_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": OPENROUTER_SITE_URL,
        "X-Title": OPENROUTER_APP_NAME,
      },
      body: JSON.stringify({
        model: OPENROUTER_EMBEDDING_MODEL,
        input: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Embedding API error: ${errorText}`);
    }

    const data = await response.json();
    const embedding = data?.data?.[0]?.embedding;

    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("No embedding returned by provider.");
    }

    embeddingProvider = "openrouter";
    return normalizeVector(embedding);
  } catch (error) {
    embeddingProvider = "local";
    if (!embeddingFallbackLogged) {
      console.warn("Embedding provider fallback: using local embeddings.", error.message || error);
      embeddingFallbackLogged = true;
    }
    return buildLocalEmbedding(text);
  }
}

async function rebuildVectorIndex(policyText) {
  currentPolicyChunks = chunkPolicyText(policyText);
  faissIndex = null;
  vectorChunkLookup = [];
  vectorSearchReady = false;

  if (!hasValidOpenRouterKey() || currentPolicyChunks.length === 0) {
    return;
  }

  const embeddings = [];
  for (const chunk of currentPolicyChunks) {
    const embedding = await getTextEmbedding(chunk);
    embeddings.push(embedding);
  }

  const dimension = embeddings[0]?.length;
  if (!dimension) {
    return;
  }

  const index = new IndexFlatIP(dimension);
  for (const embedding of embeddings) {
    index.add(embedding);
  }

  faissIndex = index;
  vectorChunkLookup = [...currentPolicyChunks];
  vectorSearchReady = true;
}

async function getSemanticRelevantChunks(question, fallbackChunks) {
  if (!vectorSearchReady || !faissIndex || faissIndex.ntotal() === 0) {
    return getRelevantChunks(question, fallbackChunks);
  }

  try {
    const questionEmbedding = await getTextEmbedding(question);
    const topK = Math.min(4, faissIndex.ntotal());
    const result = faissIndex.search(questionEmbedding, topK);

    const chunks = (result.labels || [])
      .filter((label) => Number.isInteger(label) && label >= 0 && label < vectorChunkLookup.length)
      .map((label) => vectorChunkLookup[label])
      .filter((chunk, index, arr) => arr.indexOf(chunk) === index);

    return chunks.length > 0 ? chunks : getRelevantChunks(question, fallbackChunks);
  } catch (error) {
    console.error("Vector retrieval fallback:", error.message);
    return getRelevantChunks(question, fallbackChunks);
  }
}

function getRelevantChunks(question, chunks) {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);

  if (tokens.length === 0) {
    return chunks;
  }

  const rankedChunks = chunks
    .map((chunk) => {
      const lower = chunk.toLowerCase();
      const score = tokens.reduce((count, token) => {
        return lower.includes(token) ? count + 1 : count;
      }, 0);

      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score);

  const topMatched = rankedChunks.filter((item) => item.score > 0).slice(0, 3).map((item) => item.chunk);

  return topMatched.length > 0 ? topMatched : chunks;
}

function extractBestSentence(question, chunks) {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);

  const focusTokens = getFocusTokens(question);

  const snippets = chunks
    .flatMap((chunk) =>
      chunk
        .split(/\n+|(?<=[.!?])\s+/)
        .map((part) => normalizePolicyLine(part))
        .filter(Boolean)
    )
    .filter((snippet) => snippet.length > 8)
    .filter((snippet) => !isHeadingLikeSnippet(snippet));

  if (snippets.length === 0) {
    return "Not mentioned in policy.";
  }

  let bestSentence = snippets[0];
  let bestScore = -1;
  let hasFocusTokenMatch = false;
  let bestIndex = 0;

  for (const sentence of snippets) {
    const lower = sentence.toLowerCase();
    const genericScore = tokens.reduce((count, token) => (hasWord(lower, token) ? count + 1 : count), 0);
    const focusScore = focusTokens.reduce((count, token) => (hasWord(lower, token) ? count + 1 : count), 0);
    const score = genericScore + focusScore * 2;

    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
      hasFocusTokenMatch = focusScore > 0;
      bestIndex = snippets.indexOf(sentence);
    }
  }

  if (focusTokens.length > 0 && !hasFocusTokenMatch) {
    return "Not mentioned in policy.";
  }

  const asksForQuantity = /\b(how\s+many|days?|weeks?|months?|hours?)\b/.test(question.toLowerCase());
  if (asksForQuantity && !/\d/.test(bestSentence)) {
    const nearby = [snippets[bestIndex + 1], snippets[bestIndex + 2], snippets[bestIndex - 1]].filter(Boolean);
    const withNumber = nearby.find((item) => /\d/.test(item));
    if (withNumber) {
      return withNumber;
    }
  }

  return bestScore > 0 ? bestSentence : "Not mentioned in policy.";
}

function extractComprehensiveAnswer(question, chunks) {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);

  const focusTokens = getFocusTokens(question);
  const asksWorkFromHome = /(work\s*from\s*home|wfh|remote\s*work|remote)/i.test(question);

  if (asksWorkFromHome) {
    const lines = chunks
      .flatMap((chunk) => chunk.split(/\n+/))
      .map((line) => normalizePolicyLine(line))
      .filter(Boolean);

    const seedIndexes = lines
      .map((line, index) => ({ line: line.toLowerCase(), index }))
      .filter((item) => /\b(work\s*from\s*home|wfh|remote|home\s*working)\b/i.test(item.line))
      .map((item) => item.index);

    const picked = [];
    for (const start of seedIndexes) {
      for (let i = start; i < Math.min(start + 6, lines.length); i += 1) {
        const line = lines[i];
        if (/^\d+\./.test(line) && i > start) {
          break;
        }

        if (isRuleLikeSnippet(line) && /\b(remote\w*|home|wfh|work\s*from\s*home)\b/i.test(line)) {
          picked.push(line);
        }
      }
    }

    const uniquePicked = picked
      .filter((line, index, arr) => arr.indexOf(line) === index)
      .filter((line) => !/^\d+\.\s*.*policy\s*$/i.test(line))
      .slice(0, 5);
    if (uniquePicked.length > 0) {
      return uniquePicked.map((line) => `- ${line}`).join("\n");
    }

    return "Not mentioned in policy.";
  }

  const snippets = chunks
    .flatMap((chunk) =>
      chunk
        .split(/\n+|(?<=[.!?])\s+/)
        .map((part) => normalizePolicyLine(part))
        .filter(Boolean)
    )
    .filter((snippet) => snippet.length > 8);

  if (snippets.length === 0) {
    return "Not mentioned in policy.";
  }

  const ranked = snippets
    .map((snippet, index) => {
      const lower = snippet.toLowerCase();
      const genericScore = tokens.reduce((count, token) => (hasWord(lower, token) ? count + 1 : count), 0);
      const focusScore = focusTokens.reduce((count, token) => (hasWord(lower, token) ? count + 1 : count), 0);

      const wfhBoost = asksWorkFromHome && (hasWord(lower, "remote") || (hasWord(lower, "work") && hasWord(lower, "home"))) ? 4 : 0;
      return { index, snippet, score: genericScore + focusScore * 2 + wfhBoost, focusScore };
    })
    .filter((item) => item.score > 0 && isRuleLikeSnippet(item.snippet))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (ranked.length === 0) {
    return "Not mentioned in policy.";
  }

  if (focusTokens.length > 0 && !ranked.some((item) => item.focusScore > 0)) {
    return "Not mentioned in policy.";
  }

  const selected = ranked
    .slice(0, 5)
    .map((item) => item.snippet)
    .filter((snippet, index, arr) => arr.indexOf(snippet) === index)
    .slice(0, 4);

  const wfhSelected = asksWorkFromHome
    ? selected.filter((line) => hasWord(line.toLowerCase(), "remote") || (hasWord(line.toLowerCase(), "work") && hasWord(line.toLowerCase(), "home")))
    : selected;

  const finalSelected = wfhSelected.length > 0 ? wfhSelected : selected;

  if (finalSelected.length === 0) {
    return "Not mentioned in policy.";
  }

  return finalSelected.map((line) => `- ${line}`).join("\n");
}

function answerMatchesQuestion(answer, question) {
  const focusTokens = getKeyQuestionTokens(question);

  if (focusTokens.length === 0) {
    return false;
  }

  const lowerAnswer = String(answer || "").toLowerCase();
  const matchedCount = focusTokens.reduce((count, token) => {
    return tokenMatchesAnswer(token, lowerAnswer) ? count + 1 : count;
  }, 0);

  const requiredMatches = focusTokens.length >= 3 ? 2 : 1;
  return matchedCount >= requiredMatches;
}

function isWeakAnswer(answer) {
  const cleaned = String(answer || "").trim();
  if (!cleaned) {
    return true;
  }

  if (cleaned.length < 35 && !/\d/.test(cleaned) && !/\b(may|must|should|allowed|available|eligible|not|cannot|is|are)\b/i.test(cleaned)) {
    return true;
  }

  if (/^[\w\s&-]+policy$/i.test(cleaned)) {
    return true;
  }

  if (cleaned.split(/\s+/).length <= 4 && !/\d/.test(cleaned) && !/[.!?]/.test(cleaned)) {
    const hasActionVerb = /\b(is|are|was|were|must|may|should|can|will|requires?|includes?)\b/i.test(cleaned);
    if (!hasActionVerb) {
      return true;
    }
  }

  return false;
}

function toConciseAnswer(rawAnswer, question, chunks) {
  const asksForRules = /\b(rules?|policy|guidelines?|requirements?)\b/i.test(question);
  const asksWorkFromHome = /(work\s*from\s*home|wfh|remote\s*work|remote)/i.test(question);
  const cleaned = String(rawAnswer || "").replace(/\s+/g, " ").trim();

  if (asksWorkFromHome) {
    const candidate = extractComprehensiveAnswer(question, chunks);
    return candidate;
  }

  if (!cleaned) {
    const candidate = asksForRules ? extractComprehensiveAnswer(question, chunks) : extractBestSentence(question, chunks);
    return answerMatchesQuestion(candidate, question) ? candidate : "Not mentioned in policy.";
  }

  if (!answerMatchesQuestion(cleaned, question)) {
    const candidate = asksForRules ? extractComprehensiveAnswer(question, chunks) : extractBestSentence(question, chunks);
    return answerMatchesQuestion(candidate, question) ? candidate : "Not mentioned in policy.";
  }

  if (isWeakAnswer(cleaned)) {
    const candidate = asksForRules ? extractComprehensiveAnswer(question, chunks) : extractBestSentence(question, chunks);
    return answerMatchesQuestion(candidate, question) ? candidate : "Not mentioned in policy.";
  }

  if (asksForRules) {
    const candidate = extractComprehensiveAnswer(question, chunks);
    return answerMatchesQuestion(candidate, question) ? candidate : "Not mentioned in policy.";
  }

  const completed = completeTruncatedAnswer(cleaned, chunks);
  return answerMatchesQuestion(completed, question) ? completed : "Not mentioned in policy.";
}

function extractTextFromFile(file) {
  const fileName = file.originalname.toLowerCase();
  const mimeType = file.mimetype.toLowerCase();

  const extractTextFromPdfBinaryFallback = (buffer) => {
    const raw = buffer.toString("latin1");
    const matches = raw.match(/\(([^()]*)\)\s*Tj|\[(.*?)\]\s*TJ/g) || [];
    const extracted = matches
      .map((entry) => {
        if (/\)\s*Tj$/.test(entry)) {
          const m = entry.match(/\(([^()]*)\)\s*Tj$/);
          return m?.[1] || "";
        }
        const m = entry.match(/\[(.*?)\]\s*TJ$/);
        if (!m?.[1]) {
          return "";
        }
        return m[1].replace(/\([^)]*\)/g, (part) => part.slice(1, -1)).replace(/-?\d+(\.\d+)?/g, " ");
      })
      .join(" ")
      .replace(/\\\(|\\\)|\\n|\\r|\\t/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return extracted;
  };

  if (mimeType.includes("text/plain") || fileName.endsWith(".txt") || fileName.endsWith(".md")) {
    return file.buffer.toString("utf8");
  }

  if (mimeType.includes("application/pdf") || fileName.endsWith(".pdf")) {
    return import("pdf-parse")
      .then(({ PDFParse }) => {
        const parser = new PDFParse({ data: file.buffer });
        return parser.getText().then((result) => result.text || "");
      })
      .then((text) => {
        const normalized = normalizeExtractedPolicyText(text);
        if (normalized.length >= 50) {
          return normalized;
        }

        const fallbackText = extractTextFromPdfBinaryFallback(file.buffer);
        if (fallbackText.length >= 50) {
          return fallbackText;
        }

        throw new Error("Unable to extract readable text from this PDF.");
      })
      .catch((error) => {
        const fallbackText = extractTextFromPdfBinaryFallback(file.buffer);
        if (fallbackText.length >= 50) {
          return fallbackText;
        }

        throw new Error(error.message || "Unable to extract readable text from this PDF.");
      });
  }

  if (
    mimeType.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document") ||
    fileName.endsWith(".docx")
  ) {
    return mammoth.extractRawText({ buffer: file.buffer }).then((result) => result.value);
  }

  throw new Error("Unsupported file type. Upload a .pdf, .txt, .md, or .docx file.");
}

function buildPolicyChunks() {
  return currentPolicyChunks.length > 0 ? currentPolicyChunks : chunkPolicyText(currentPolicyText);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/policy", (_req, res) => {
  res.json({
    source: currentPolicySource,
    policyText: currentPolicyText,
    vectorSearchReady,
    chunkCount: buildPolicyChunks().length,
    embeddingProvider,
    llmConfigured: hasValidOpenRouterKey(),
  });
});

app.post("/policy/upload", upload.single("policyDocument"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload a policy document." });
    }

    const extractedText = await extractTextFromFile(req.file);
    const cleanedText = normalizeExtractedPolicyText(extractedText);

    if (!cleanedText) {
      return res.status(400).json({ message: "The uploaded file did not contain readable policy text." });
    }

    currentPolicyText = cleanedText;
    currentPolicySource = req.file.originalname;
    let warning = null;
    try {
      await rebuildVectorIndex(currentPolicyText);
    } catch (error) {
      // Upload should still succeed even if vector indexing fails.
      vectorSearchReady = false;
      warning = "Vector index could not be created. Falling back to keyword retrieval.";
      console.error("Vector index build error after upload:", error.message || error);
    }

    res.json({
      message: warning ? "Policy uploaded with fallback mode." : "Policy document uploaded successfully.",
      source: currentPolicySource,
      vectorSearchReady,
      embeddingProvider,
      warning,
    });
  } catch (error) {
    console.error("Error in /policy/upload:", error);
    res.status(400).json({
      message: error.message || "Unable to read the uploaded policy document.",
    });
  }
});

app.post("/policy/reset", (_req, res) => {
  currentPolicyText = normalizeExtractedPolicyText(defaultPolicyText);
  currentPolicySource = "Default company policy";
  rebuildVectorIndex(currentPolicyText)
    .then(() => {
      res.json({
        message: "Policy reset to default company policy.",
        source: currentPolicySource,
        vectorSearchReady,
        embeddingProvider,
      });
    })
    .catch((error) => {
      console.error("Error rebuilding vector index during reset:", error.message || error);
      vectorSearchReady = false;
      res.json({
        message: "Policy reset completed with keyword fallback mode.",
        source: currentPolicySource,
        vectorSearchReady,
        embeddingProvider,
        warning: "Vector index could not be created. Falling back to keyword retrieval.",
      });
    });
});

app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || typeof question !== "string") {
      return res.status(400).json({ answer: "Please provide a valid question." });
    }

    const policyChunks = buildPolicyChunks();
    const relevantChunks = await getSemanticRelevantChunks(question, policyChunks);
    const context = relevantChunks.join("\n\n---\n\n");

    const prompt = `You are an HR policy assistant.
Answer ONLY using the company policy below.
If the answer is not present , say exactly: Not mentioned in policy.
    Keep the answer factual, complete, and directly relevant to the specific question.Remove any serial numbers and bulletins. The answer should be meaingful.

Policy:
${context}

Question:
${question}`;

    let answer = "";

    if (hasValidOpenRouterKey()) {
      const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": OPENROUTER_SITE_URL,
          "X-Title": OPENROUTER_APP_NAME,
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You answer questions only from the provided company policy. If the answer is not in the policy, say exactly: Not mentioned in policy.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.2,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        answer = data?.choices?.[0]?.message?.content?.trim() || "";
      } else {
        const errorText = await response.text();
        console.error("OpenRouter error:", errorText);
      }
    }

    if (!answer) {
      answer = extractBestSentence(question, relevantChunks);
    }

    answer = toConciseAnswer(answer, question, relevantChunks);

    res.json({ answer, source: currentPolicySource });
  } catch (error) {
    console.error("Error in /ask:", error);
    res.status(500).json({ answer: "Unable to generate an answer at the moment." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  if (!hasValidOpenRouterKey()) {
    console.warn("OpenRouter API key is missing or placeholder. Using extractive fallback answers only.");
  }
});

rebuildVectorIndex(currentPolicyText)
  .then(() => {
    console.log(`FAISS vector index ready: ${vectorSearchReady} (chunks: ${buildPolicyChunks().length})`);
  })
  .catch((error) => {
    console.error("Failed to initialize FAISS vector index. Falling back to keyword retrieval.", error.message);
  });
