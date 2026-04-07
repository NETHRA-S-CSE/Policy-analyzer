const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const mammoth = require("mammoth");

if (typeof global.DOMMatrix === "undefined") {
  global.DOMMatrix = class DOMMatrix {};
}

if (typeof global.ImageData === "undefined") {
  global.ImageData = class ImageData {};
}

if (typeof global.Path2D === "undefined") {
  global.Path2D = class Path2D {};
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || "http://localhost:5173";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "Company Policy RAG Assistant";

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

let currentPolicyText = defaultPolicyText;
let currentPolicySource = "Default company policy";

function chunkPolicyText(text, maxWordsPerChunk = 220) {
  const paragraphs = text
    .split("\n\n")
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks = [];
  let currentChunk = "";
  let currentWordCount = 0;

  for (const paragraph of paragraphs) {
    const paragraphWordCount = paragraph.split(/\s+/).length;

    if (currentWordCount + paragraphWordCount > maxWordsPerChunk && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
      currentWordCount = paragraphWordCount;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
      currentWordCount += paragraphWordCount;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
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
  const stopWords = new Set([
    "how",
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
  ]);

  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);

  const focusTokens = tokens.filter((token) => !stopWords.has(token));

  const snippets = chunks
    .flatMap((chunk) =>
      chunk
        .split(/\n+|(?<=[.!?])\s+/)
        .map((part) => part.replace(/^[-*\s]+/, "").trim())
        .filter(Boolean)
    )
    .filter((snippet) => snippet.length > 8);

  if (snippets.length === 0) {
    return "Not mentioned in policy.";
  }

  let bestSentence = snippets[0];
  let bestScore = -1;
  let hasFocusTokenMatch = false;
  let bestIndex = 0;

  for (const sentence of snippets) {
    const lower = sentence.toLowerCase();
    const genericScore = tokens.reduce((count, token) => (lower.includes(token) ? count + 1 : count), 0);
    const focusScore = focusTokens.reduce((count, token) => (lower.includes(token) ? count + 1 : count), 0);
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

function toConciseAnswer(rawAnswer, question, chunks) {
  const cleaned = String(rawAnswer || "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return extractBestSentence(question, chunks);
  }

  if (cleaned.length <= 280) {
    return cleaned;
  }

  return extractBestSentence(question, chunks);
}

function extractTextFromFile(file) {
  const fileName = file.originalname.toLowerCase();
  const mimeType = file.mimetype.toLowerCase();

  if (mimeType.includes("text/plain") || fileName.endsWith(".txt") || fileName.endsWith(".md")) {
    return file.buffer.toString("utf8");
  }

  if (mimeType.includes("application/pdf") || fileName.endsWith(".pdf")) {
    return import("pdf-parse").then(({ PDFParse }) => {
      const parser = new PDFParse({ data: file.buffer });
      return parser.getText().then((result) => result.text || "");
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
  return chunkPolicyText(currentPolicyText);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/policy", (_req, res) => {
  res.json({
    source: currentPolicySource,
    policyText: currentPolicyText,
  });
});

app.post("/policy/upload", upload.single("policyDocument"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload a policy document." });
    }

    const extractedText = await extractTextFromFile(req.file);
    const cleanedText = extractedText.replace(/\u0000/g, "").trim();

    if (!cleanedText) {
      return res.status(400).json({ message: "The uploaded file did not contain readable policy text." });
    }

    currentPolicyText = cleanedText;
    currentPolicySource = req.file.originalname;

    res.json({
      message: "Policy document uploaded successfully.",
      source: currentPolicySource,
    });
  } catch (error) {
    console.error("Error in /policy/upload:", error);
    res.status(400).json({
      message: error.message || "Unable to read the uploaded policy document.",
    });
  }
});

app.post("/policy/reset", (_req, res) => {
  currentPolicyText = defaultPolicyText;
  currentPolicySource = "Default company policy";

  res.json({
    message: "Policy reset to default company policy.",
    source: currentPolicySource,
  });
});

app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || typeof question !== "string") {
      return res.status(400).json({ answer: "Please provide a valid question." });
    }

    const policyChunks = buildPolicyChunks();
    const relevantChunks = getRelevantChunks(question, policyChunks);
    const context = relevantChunks.join("\n\n---\n\n");

    const prompt = `You are an HR policy assistant.
Answer ONLY using the company policy below.
If the answer is not present, say exactly: Not mentioned in policy.
Keep the answer concise and factual.

Policy:
${context}

Question:
${question}`;

    let answer = "";

    if (process.env.OPENROUTER_API_KEY) {
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
});
