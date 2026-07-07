/**
 * TikTok Business API client.
 *
 * Handles outbound communication with TikTok's Business API for:
 *   - Replying to video comments
 *   - Sending direct messages (DMs)
 *
 * Uses the official TikTok API for Business v1.3 endpoints.
 * Requires a valid Business Account access token obtained via OAuth.
 *
 * API Reference: https://business-api.tiktok.com/
 */

// ============================================================
// Constants
// ============================================================

const TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api'
const API_VERSION = 'v1.3'

// ============================================================
// Types
// ============================================================

interface TikTokApiResponse {
  code: number
  message: string
  data: Record<string, unknown>
}

interface ReplyToCommentParams {
  accessToken: string
  businessId: string
  videoId: string
  commentId: string
  text: string
}

interface SendDirectMessageParams {
  accessToken: string
  businessId: string
  recipientOpenId: string
  text: string
}

interface TikTokCommentReplyResult {
  success: boolean
  commentId?: string
  error?: string
}

interface TikTokDMResult {
  success: boolean
  messageId?: string
  error?: string
}

// ============================================================
// Public API
// ============================================================

/**
 * Reply to a comment on a TikTok Business video.
 *
 * Uses the official Business Comment Reply endpoint. The reply
 * appears as a nested comment under the original comment on the
 * video post.
 */
export async function replyToComment({
  accessToken,
  businessId,
  videoId,
  commentId,
  text,
}: ReplyToCommentParams): Promise<TikTokCommentReplyResult> {
  const url = `${TIKTOK_API_BASE}/${API_VERSION}/business/comment/reply/create/`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': accessToken,
      },
      body: JSON.stringify({
        business_id: businessId,
        video_id: videoId,
        comment_id: commentId,
        text,
      }),
    })

    const body = (await res.json()) as TikTokApiResponse

    if (body.code !== 0) {
      console.error('[tiktok/api] Comment reply failed:', body.message)
      return { success: false, error: body.message }
    }

    const replyId =
      typeof body.data?.comment_id === 'string'
        ? body.data.comment_id
        : undefined

    console.log(
      `[tiktok/api] Comment reply sent successfully (commentId: ${replyId ?? 'unknown'})`,
    )
    return { success: true, commentId: replyId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[tiktok/api] Comment reply network error:', message)
    return { success: false, error: message }
  }
}

/**
 * Send a direct message to a TikTok user.
 *
 * Uses the Business Messaging API. The conversation must have
 * been initiated by the user first (TikTok policy). The message
 * appears in the user's TikTok DM inbox.
 */
export async function sendDirectMessage({
  accessToken,
  businessId,
  recipientOpenId,
  text,
}: SendDirectMessageParams): Promise<TikTokDMResult> {
  const url = `${TIKTOK_API_BASE}/${API_VERSION}/business/message/send/`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': accessToken,
      },
      body: JSON.stringify({
        business_id: businessId,
        open_id: recipientOpenId,
        message_type: 'text',
        text: { text },
      }),
    })

    const body = (await res.json()) as TikTokApiResponse

    if (body.code !== 0) {
      console.error('[tiktok/api] DM send failed:', body.message)
      return { success: false, error: body.message }
    }

    const msgId =
      typeof body.data?.message_id === 'string'
        ? body.data.message_id
        : undefined

    console.log(
      `[tiktok/api] DM sent successfully (messageId: ${msgId ?? 'unknown'})`,
    )
    return { success: true, messageId: msgId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[tiktok/api] DM send network error:', message)
    return { success: false, error: message }
  }
}
