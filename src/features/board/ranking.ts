import type { BoardPost } from '../../domain/index'

// Two-stage discovery applies to the Board too (§2.2, §8.3): the service HARD-FILTERS first,
// then this module SOFT-RANKS the survivors using only load-bearing signals. There is NO
// engagement signal, NO recency-of-marketing, and NO paid placement (§2.3, §8.4) — posting fees
// buy durability/reach of a signed record, never ranking weight. Free-text prose never feeds
// the score (§10.3): only typed fields (created, author trust, OFFER/RFP price) do.

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

export interface RankSignals {
  readonly recency: number
  readonly author_trust: number
  readonly price: number
}

export interface MatchExplanation {
  readonly post_id: string
  readonly score: number
  readonly signals: RankSignals
  readonly notes: readonly string[]
}

export interface RankedPost {
  readonly post: BoardPost
  readonly explanation: MatchExplanation
}

export interface RankContext {
  readonly nowMs: number
  readonly trustFor: (did: string) => number
}

// Weights for the board's load-bearing signals. Recency: a fresher signal is more actionable.
// Author trust: cross-surface standing (§9.3). Price: cheaper OFFER / leaner RFP budget reads
// as a stronger signal, but it is only one of three and never the sole driver.
export const RANK_WEIGHTS = {
  recency: 0.4,
  trust: 0.45,
  price: 0.15,
} as const

// Recency decays over a 7-day horizon: a post created now scores 1, a 7-day-old post scores 0.
const RECENCY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000

// Price headroom saturates at this amount: any OFFER/RFP at/above it scores 0 on price, free
// scores 1. A unit-free normalization so a $0.01 offer and a $10 offer separate on the signal.
const PRICE_SATURATION = 100

const recencyScore = (createdIso: string, nowMs: number): number => {
  const ageMs = nowMs - new Date(createdIso).getTime()
  if (Number.isNaN(ageMs)) return 0
  if (ageMs <= 0) return 1
  return clamp01(1 - ageMs / RECENCY_HORIZON_MS)
}

// Price is a ranking signal only for posts that carry one (OFFER price_from, RFP budget). Other
// post types are price-neutral (score 1 on the price axis so the absence neither helps nor hurts
// relative to a free offer).
const priceScore = (post: BoardPost): number => {
  let amount: number | null = null
  if (post.type === 'OFFER') amount = Number(post.price_from.amount)
  else if (post.type === 'RFP') amount = Number(post.budget.amount)
  if (amount === null || Number.isNaN(amount)) return 1
  return clamp01(1 - amount / PRICE_SATURATION)
}

export const rankPosts = (posts: readonly BoardPost[], ctx: RankContext): RankedPost[] => {
  const w = RANK_WEIGHTS
  const ranked = posts.map((post): RankedPost => {
    const recency = recencyScore(post.created, ctx.nowMs)
    const author_trust = clamp01(ctx.trustFor(post.author))
    const price = priceScore(post)
    const score = w.recency * recency + w.trust * author_trust + w.price * price

    const notes: string[] = []
    if (author_trust === 0) notes.push('author has no measured standing (cold start)')
    if (recency >= 0.99) notes.push('freshly posted')
    if (post.type !== 'OFFER' && post.type !== 'RFP') notes.push('price signal not applicable')

    return { post, explanation: { post_id: post.post_id, score, signals: { recency, author_trust, price }, notes } }
  })

  // Stable sort by score desc; ties break by higher seq (newer chain position) so ordering is
  // deterministic and pagination cursors are stable.
  return ranked.sort((a, b) => {
    if (b.explanation.score !== a.explanation.score) return b.explanation.score - a.explanation.score
    return b.post.seq - a.post.seq
  })
}
