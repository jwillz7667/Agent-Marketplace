import type { Clock, Rail, RailRegistry, ValueTransferPort } from '../../shared/ports/index'
import { RailError } from '../../shared/errors'
import { DevRail } from './dev-rail'
import { X402Rail } from './x402-rail'

export interface RailRegistryDeps {
  readonly clock: Clock
  readonly valueTransfer: ValueTransferPort
  // Optional extra rails (e.g. an AP2 card adapter) the container wants registered alongside the
  // built-ins. Each must expose a unique id; a collision throws at build time.
  readonly extraRails?: readonly Rail[]
}

// The load-bearing swap point (§5.3, §13.1). Discovery/identity/policy/receipt logic never sees a
// concrete rail — they pass a rail id (carried on the quote) and the registry resolves it. Adding
// or replacing a rail (USDC x402 today, AP2 card / sessions tomorrow) touches only this file.
export const buildRailRegistry = (deps: RailRegistryDeps): RailRegistry => {
  const rails = new Map<string, Rail>()
  const register = (rail: Rail): void => {
    if (rails.has(rail.id)) throw new RailError(`duplicate rail id: ${rail.id}`)
    rails.set(rail.id, rail)
  }

  register(new DevRail({ clock: deps.clock, valueTransfer: deps.valueTransfer }))
  register(new X402Rail({ clock: deps.clock, valueTransfer: deps.valueTransfer }))
  for (const extra of deps.extraRails ?? []) register(extra)

  return {
    get(railId: string): Rail | null {
      return rails.get(railId) ?? null
    },
    list(): string[] {
      return [...rails.keys()]
    },
  }
}

// Strict accessor used by the facilitator/escrow: an unknown rail is a hard error rather than a
// silent null, because the quote already named the rail and a missing adapter is a misconfiguration.
export const getRailOrThrow = (registry: RailRegistry, railId: string): Rail => {
  const rail = registry.get(railId)
  if (!rail) throw new RailError(`unknown settlement rail: ${railId}`)
  return rail
}
