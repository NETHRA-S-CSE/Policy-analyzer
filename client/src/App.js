import { useState } from "react";
import "./App.css";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

function App() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState([]);

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
        { question: trimmedQuestion, answer },
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
                <p className="source">Source: Company Policy</p>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

export default App;
