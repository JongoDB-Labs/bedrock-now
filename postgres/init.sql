-- litellm DB is created by POSTGRES_DB. Open WebUI gets its own DB (+ pgvector for RAG).
CREATE DATABASE openwebui;
\connect openwebui
CREATE EXTENSION IF NOT EXISTS vector;
