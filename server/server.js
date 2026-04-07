const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || "http://localhost:5173";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "Company Policy RAG Assistant";

app.use(cors());
app.use(express.json());

const companyPolicyText = `
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

const policyChunks = chunkPolicyText(companyPolicyText);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || typeof question !== "string") {
      return res.status(400).json({ answer: "Please provide a valid question." });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({
        answer: "OPENROUTER_API_KEY is not configured on the server.",
      });
    }

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

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter error:", errorText);
      return res.status(502).json({ answer: "Unable to generate an answer at the moment." });
    }

    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      return res.status(502).json({ answer: "Unable to generate an answer at the moment." });
    }

    res.json({ answer });
  } catch (error) {
    console.error("Error in /ask:", error);
    res.status(500).json({ answer: "Unable to generate an answer at the moment." });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
