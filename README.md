# Policy-analyzer
AI-powered RAG-based web application built for a hackathon to enable users to query company policies using natural language. Generates accurate, context-aware answers by retrieving relevant policy information and leveraging LLMs.

## Project Overview

Company Policy Assistant is a lightweight RAG-style HR assistant built with React + Node.js.
Users can upload policy documents and ask plain-language questions such as leave rules, attendance norms, work-from-home conditions, and HR compliance points.

The backend chunks policy text, retrieves relevant sections, and generates grounded answers.
If the LLM service is unavailable, a local extractive fallback still responds from policy content.

## Core Features

- Upload policy documents from UI (`.txt`, `.md`, `.docx`, `.pdf`)
- Ask policy questions in natural language
- Source-aware responses showing which policy file was used
- Reset to default policy text instantly
- Local in-memory operation with no database

## Advantages

- Faster HR query resolution without waiting for manual responses
- Consistent policy interpretation across teams and employees
- Reduced hallucination risk via policy-grounded context
- Quick deployment and low operational complexity for internal use


## Policy Upload

The app now supports uploading a policy document from the UI and answering questions from that uploaded content.

Supported formats:
- `.txt`
- `.md`
- `.docx`
- `.pdf`

If the OpenRouter API is unavailable or the key is invalid, the backend still returns an extractive answer from the uploaded policy text so the app remains usable.
