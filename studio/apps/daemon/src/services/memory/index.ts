// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — the one entry point for code outside this folder. Everything else in the folder is an
// implementation detail of the engine.

export { createMemoryEngine } from "./engine.js";
export { MemoryError } from "./types.js";
export type {
  ChunkSink,
  ChunkWindow,
  DistillTarget,
  EmbeddingProvider,
  EngineDistillInput,
  EngineListQuery,
  IngestMessage,
  JudgeVerdict,
  MemoryActor,
  MemoryChunkRow,
  MemoryConflictRow,
  MemoryEngineApi,
  MemoryEngineDeps,
  MemoryItemRow,
  MemoryJudge,
  MemoryLlm,
  MemoryLocalRuntime,
  MemoryProviders,
  RecallRequest,
  RecallResult,
  RememberInput,
  RememberResult,
  RerankProvider,
  ReviseInput,
} from "./types.js";

export {
  canReadDataClass,
  chunkScopeKeys,
  remoteAllowed,
  resolveReadScopeKeys,
  resolveReadScopes,
  type ChunkScopeInput,
  type MemoryAccessContext,
} from "./policy.js";

export {
  buildWindows,
  ingestPaConversation,
  syncStudioConversation,
  sweepDeletedStudioConversations,
  syncStudioProject,
  type PaConversationReader,
} from "./ingest.js";
