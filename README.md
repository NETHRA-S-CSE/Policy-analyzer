# Policy-analyzer
AI-powered RAG-based web application built for a hackathon to enable users to query company policies using natural language. Generates accurate, context-aware answers by retrieving relevant policy information and leveraging LLMs.

## Policy Upload

The app now supports uploading a policy document from the UI and answering questions from that uploaded content.

Supported formats:
- `.txt`
- `.md`
- `.docx`
- `.pdf`

If the OpenRouter API is unavailable or the key is invalid, the backend still returns an extractive answer from the uploaded policy text so the app remains usable.
