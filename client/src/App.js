import { useState } from "react";
import "./App.css";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

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
      <section className="card">
        <h1>Company Policy Assistant</h1>
        <p className="subtitle">Ask HR policy questions based on internal policy text.</p>

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

        <form className="ask-form" onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="Example: How many sick leaves do I get?"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !question.trim()}>
            Ask
          </button>
        </form>

        {loading && <p className="loading">Thinking...</p>}

        <div className="chat-list">
          {chatHistory.length === 0 ? (
            <p className="empty-state">Your Q&A will appear here.</p>
          ) : (
            chatHistory.map((item, index) => (
              <article key={`${item.question}-${index}`} className="chat-item">
                <p className="label">Question</p>
                <p>{item.question}</p>
                <p className="label">Answer</p>
                <p>{item.answer}</p>
                <p className="source">Source: {item.source || activeSource}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

export default App;
