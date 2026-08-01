# ADR: Semantic memory search — pgvector in-house, not supermemory

Status: proposed
Date: 2026-08-01

## Decision

Evaluated adopting supermemory (github.com/supermemoryai/supermemory) as a memory
backend. Rejected as a default dependency; adopt pgvector-based semantic search
over the existing Postgres memory store instead.

## Why

- The MIT license covers the web app, SDKs, and MCP server — the actual memory
  engine ships as a closed-source binary, and production self-hosting is gated
  behind paid plans ($399+/mo). Incompatible with an MIT self-hosted product's
  "your data, your infra, auditable" pitch.
- QM memory is a revision-controlled document (MEMORY.md with CAS revisions,
  history, restore) with write-path provenance rewriting (`foldCapture`). Six of
  nine `MemoryService` methods have no supermemory mapping, and its extraction/
  merge pipeline would destroy provenance labels. At best it could be a sidecar
  search index — a second stateful system to improve one method.
- The actual gap is `query` (naive substring AND-match). Bullets are atomic,
  dated, capped at 300 per scope: a tiny corpus. pgvector + one embedding per
  captured bullet gives semantic query/recall ranking with zero new infra,
  scoping and provenance untouched.

## Plan

1. `memory_embeddings(scope_id, seq, bullet_hash, embedding vector)` alongside
   `memory_revisions`; embed on capture, backfill lazily on first query.
2. Hybrid ranking in `queryBullets`: vector similarity + keyword match, scope
   filtering unchanged (isolation stays in QM code, not an external engine).
3. Embedding provider follows the configured model provider; degrade to
   substring search when no embedding key is configured or the call fails.
4. Revisit supermemory only as an opt-in sidecar for customers who bring their
   own supermemory Enterprise deployment, with QM's store remaining canonical.
