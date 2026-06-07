import { z } from 'zod'

// Zod validation for the reputation HTTP surface (§9). The module is READ-ONLY over HTTP:
// snapshots are produced from settled receipts and signals, never posted by clients. So the
// only inbound validation is the path param; responses are schema'd for the type provider.
// There is deliberately NO stars/rating/review field anywhere — reputation is measured (§9.2).

export const SubjectParamsSchema = z.object({
  did: z.string().min(1),
})

const LatencySchema = z.object({
  p50: z.number(),
  p95: z.number(),
})

export const MetricsSchema = z.object({
  success_rate: z.number(),
  dispute_rate: z.number(),
  refund_rate: z.number(),
  latency_ms: LatencySchema,
  uptime: z.number(),
  jobs: z.number().int(),
  settled_value: z.string(),
  stake: z.string(),
  first_seen: z.string().nullable(),
  last_settled: z.string().nullable(),
  counterparty_diversity: z.number(),
  spam_flags: z.number(),
  post_flags: z.number(),
})

// GET /reputation/:did — the signed ReputationSnapshot (§9.2).
export const SnapshotResponseSchema = z.object({
  snapshot_id: z.string(),
  subject: z.string(),
  window: z.string(),
  metrics: MetricsSchema,
  trust: z.number(),
  issued: z.string(),
  expires: z.string(),
  issuer: z.string(),
  sig: z.string(),
})

// GET /reputation/:did/raw — underlying metrics so an agent can recompute trust itself.
export const RawResponseSchema = MetricsSchema

export type SubjectParams = z.infer<typeof SubjectParamsSchema>
