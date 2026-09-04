/* eslint-disable jsdoc/require-jsdoc */

import { isTokenCompatibleWithModel } from "~/services/models/utils/tokenModelCompatibility"
import type { AccountToken } from "~/types"

interface TokenMatchOffering {
  groupName: string
  groupIsFallback?: boolean
  modelName: string
  sourceIdentity?: { kind?: string }
  tokenId?: number
}

function getAccountTokenGroupName(token: Pick<AccountToken, "group">) {
  return typeof token.group === "string" && token.group.trim()
    ? token.group.trim()
    : "default"
}

export function findCompatibleOfferingTokens(
  tokens: readonly AccountToken[],
  offering: TokenMatchOffering,
) {
  const scopedTokens =
    offering.sourceIdentity?.kind === "account-token" &&
    offering.tokenId !== undefined
      ? tokens.filter((token) => token.id === offering.tokenId)
      : tokens

  return scopedTokens.filter((token) =>
    isTokenCompatibleWithModel(token, {
      id: offering.modelName,
      enableGroups: offering.groupIsFallback ? undefined : [offering.groupName],
    }),
  )
}

export function resolveTokenBoundGroupName(
  offering: Pick<TokenMatchOffering, "groupName" | "groupIsFallback">,
  token: Pick<AccountToken, "group">,
) {
  return offering.groupIsFallback
    ? getAccountTokenGroupName(token)
    : offering.groupName
}

export function createTokenBoundOfferingId(
  offeringId: string,
  tokenId: number,
) {
  return `${offeringId}:token:${tokenId}`
}
