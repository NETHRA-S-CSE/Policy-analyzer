import { useState } from "react";
import "./App.css";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
const SAMPLE_QUESTIONS = [
  "How many sick leaves are allowed?",
  "What are the work from home rules?",
  "Is maternity leave mentioned in policy?",
  "What happens on repeated late attendance?",
];

const PROJECT_POINTS = [
  "Upload HR policy documents and query them instantly.",
  "Answers are grounded to policy text, reducing hallucinated responses.",
  
];

const ADVANTAGES = [
  "Faster HR support: employees self-serve routine policy questions.",
  "Consistency: every answer follows the same policy source of truth.",
  
];

function App() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [activeSource, setActiveSource] = useState("Default company policy");
  const [uploadMessage, setUploadMessage] = useState("");
  const [chatHistory, setChatHistory] = useState([]);

  const handleFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setSelectedFile(file);
    setUploadMessage("");
  };

  const handleUpload = async (event) => {
    event.preventDefault();

    if (!selectedFile) {
      setUploadMessage("Choose a policy document first.");
      return;
    }

    setUploading(true);
    setUploadMessage("");

    try {
      const formData = new FormData();
      formData.append("policyDocument", selectedFile);

      const response = await fetch(`${API_BASE_URL}/policy/upload`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Unable to upload policy document.");
      }

      setActiveSource(data.source || selectedFile.name);
      setUploadMessage(data.message || "Policy document uploaded successfully.");
      setSelectedFile(null);
      event.target.reset();
    } catch (error) {
      setUploadMessage(error.message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const handleResetPolicy = async () => {
    setUploading(true);
    setUploadMessage("");

    try {
      const response = await fetch(`${API_BASE_URL}/policy/reset`, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Unable to reset policy.");
      }

      setActiveSource(data.source || "Default company policy");
      setSelectedFile(null);
      setUploadMessage(data.message || "Policy reset.");
    } catch (error) {
      setUploadMessage(error.message || "Reset failed.");
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: trimmedQuestion }),
      });

      const data = await response.json();
      const answer = data.answer || "No answer returned.";

      setChatHistory((prev) => [
        ...prev,
        { question: trimmedQuestion, answer, source: data.source || activeSource },
      ]);
      setQuestion("");
    } catch (error) {
      setChatHistory((prev) => [
        ...prev,
        {
          question: trimmedQuestion,
          answer: "Server error. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">RAG Demo</p>
        <h1>Company Policy Assistant</h1>
        <p className="subtitle">Upload policy docs, ask natural questions, and get grounded policy-first answers.</p>
      </section>

      <section className="layout-grid">
        <aside className="info-panel">
          <h2>About This Project</h2>
          <ul className="content-list">
            {PROJECT_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>

          <h2>Advantages</h2>
          <ul className="content-list">
            {ADVANTAGES.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>

          <h2>Try These Questions</h2>
          <div className="question-chips">
            {SAMPLE_QUESTIONS.map((sample) => (
              <button key={sample} type="button" className="chip" onClick={() => setQuestion(sample)}>
                {sample}
              </button>
            ))}
          </div>
        </aside>

        <section className="card">
          <form className="upload-form" onSubmit={handleUpload}>
            <div className="upload-row">
              <input
                className="file-input"
                type="file"
                accept=".pdf,.txt,.md,.docx"
                onChange={handleFileChange}
                disabled={uploading}
              />
              <button type="submit" disabled={uploading || !selectedFile}>
                {uploading ? "Uploading..." : "Upload Policy"}
              </button>
              <button type="button" className="secondary-button" onClick={handleResetPolicy} disabled={uploading}>
                Reset
              </button>
            </div>
            <p className="source current-source">Current source: {activeSource}</p>
            {selectedFile && <p className="file-name">Selected file: {selectedFile.name}</p>}
            {uploadMessage && <p className="upload-message">{uploadMessage}</p>}
          </form>

          <div className="chat-window">
            {chatHistory.length === 0 ? (
              <div className="empty-state">
                <p className="assistant-name">Assistant</p>
                <p>Hi, upload a policy document and ask any HR question to get policy-grounded answers.</p>
              </div>
            ) : (
              chatHistory.map((item, index) => (
                <div key={`${item.question}-${index}`} className="chat-turn">
                  <div className="message-row user-row">
                    <p className="role-label">You</p>
                    <p className="message-bubble user-bubble">{item.question}</p>
                  </div>

                  <div className="message-row assistant-row">
                    <p className="role-label assistant-name">Assistant</p>
                    <div className="message-bubble assistant-bubble">
                      <p>{item.answer}</p>
                      <p className="source">Source: {item.source || activeSource}</p>
                    </div>
                  </div>
                </div>
              ))
            )}

            {loading && (
              <div className="message-row assistant-row">
                <p className="role-label assistant-name">Assistant</p>
                <p className="message-bubble assistant-bubble typing">Thinking...</p>
              </div>
            )}
          </div>

          <form className="ask-form" onSubmit={handleSubmit}>
            <input
              type="text"
              placeholder="Ask a policy question..."
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              disabled={loading}
            />
            <button type="submit" disabled={loading || !question.trim()}>
              Send
            </button>
          </form>
        </section>
      </section>
    </main>
  );
}

export default App;
