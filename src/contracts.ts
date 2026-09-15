import type { Finding, LookupRequest } from './review/schema.js';

export type { Finding, LookupRequest, TaskResponse } from './review/schema.js';
export type Side = 'LEFT' | 'RIGHT';
export type ReviewStatus = 'complete' | 'partial' | 'unavailable' | 'skipped' | 'superseded';
export type PublicationStatus = 'published' | 'partial' | 'failed' | 'uncertain' | 'not_requested';
export type ReviewTask = { kind: 'review'; id: string; lineageId: string; atomIds: string[]; evidenceIds: string[] };
export type IntegrationTask = { kind: 'integration'; id: string; lineageId: string; relationIds: string[]; evidenceIds: string[] };
export type Task = ReviewTask | IntegrationTask;
export const obligations = (task: Task): string[] => task.kind === 'review' ? task.atomIds : task.relationIds;
export type Atom = {
  id: string; path: string; oldPath: string; side: Side; start: number; end: number;
  text: string; evidenceIds: string[]; priority: number;
};
export type Evidence = { id: string; path: string; revision: string; blobId: string; side: Side; start: number; end: number; text: string };
export type Relation = { id: string; question: string; atomIds: string[]; evidenceIds: string[] };
export type Omission = { path: string; reason: string };
export type Manifest = {
  repository: string; repositoryId: number; prNumber: number; baseRef: string;
  baseSha: string; mergeBaseSha: string; headSha: string; actionRevision: string;
  model: string; configurationHash: string; promptHash: string; schemaHash: string; ruleHash: string;
  evidenceBlobs: Record<string, { revision: string; path: string; blobId: string }>;
};
export type Inventory = { atoms: Atom[]; evidence: Map<string, Evidence>; omissions: Omission[]; relations: Relation[] };
export type LookupResult = { request: LookupRequest; evidence: Evidence[]; limited: boolean; reason?: string };
export type Diagnostic = { taskId?: string; reason: string; disposition?: 'rejected_invalid_evidence' | 'unresolved_missing_context' };
export type Attempt = { taskId: string; preflight: number; finishReason?: string; totalTokenCount?: number; promptTokenCount?: number;
  candidatesTokenCount?: number; thoughtsTokenCount?: number; error?: string };
export type UsageReport = {
  model: string; generationAttempts: number; reportedAttempts: number; unreportedAttempts: number;
  totalTokens: number | null; inputTokens: number | null; outputTokens: number | null;
  componentAttempts: number; thoughtsTokens: number | null; thoughtsReportedAttempts: number;
  estimatedCostUsd: number | null; pricedAttempts: number; pricingChecked: string; pricingSource: string;
  pricingBasis: string; unavailableReason?: string;
};
export type Analysis = {
  status: ReviewStatus; analysisStatus: Exclude<ReviewStatus, 'superseded'>; superseded: boolean;
  atoms: Record<string, { status: 'pending' | 'reviewed' | 'unresolved'; reason: string }>;
  relations: Record<string, { status: 'pending' | 'reviewed' | 'unresolved'; reason: string }>;
  findings: Finding[]; diagnostics: Diagnostic[]; attempts: Attempt[];
  usage: { attempts: number; charged: number; reserved: number; unknown: number };
};
export type Operation = {
  id: string; required: boolean; contentHash: string; state: 'pending' | 'confirmed' | 'failed' | 'unconfirmed';
  findingIds: string[]; remoteId?: number; error?: string;
};
export type Publication = { started: boolean; status: PublicationStatus; operations: Operation[]; superseded: boolean };
export type RunOrder = { createdAt: string; runId: string; attempt: number };
export type FinalizedRun = {
  usageReport?: UsageReport;
  manifest?: Manifest; analysis: Analysis; publication: Publication; omissions: Omission[];
  configurationError?: string; internalError?: string; notices: string[];
};
