/**
 * Book Appointment skill — lets the AI agent check calendar availability
 * and book appointments for customers.
 *
 * The LLM calls this when a customer wants to schedule a meeting,
 * consultation, or service appointment. The skill checks the business
 * calendar for available slots and creates the booking.
 */

import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'

// ============================================================
// Day-of-week helpers
// ============================================================

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

export const bookAppointmentSkill: SkillDefinition = {
  type: 'book_appointment',
  tool: {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'Check calendar availability and book appointments. Use this when a ' +
        'customer wants to schedule a meeting, consultation, or service. ' +
        'First call with action "check_availability" to see open slots, ' +
        'then call with action "book" to confirm the appointment.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['check_availability', 'book'],
            description:
              '"check_availability" — returns available time slots for a given date. ' +
              '"book" — books a specific slot.',
          },
          date: {
            type: 'string',
            description:
              'The date to check or book, in YYYY-MM-DD format. ' +
              'For check_availability, shows all open slots on this date. ' +
              'For book, the date of the appointment.',
          },
          time: {
            type: 'string',
            description:
              'The time slot to book, in HH:mm format (24h). ' +
              'Required for "book" action. Must be one of the available slots.',
          },
          title: {
            type: 'string',
            description:
              'Short description of the appointment. Required for "book" action.',
          },
          notes: {
            type: 'string',
            description: 'Additional notes about what the customer needs.',
          },
        },
        required: ['action', 'date'],
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()
    const action = params.action as string
    const dateStr = params.date as string

    try {
      // Find the calendar for this account
      const { data: calendar } = await db
        .from('ai_calendars')
        .select('*')
        .eq('account_id', context.accountId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (!calendar) {
        return {
          success: false,
          data: 'No calendar is set up yet. Please ask the business to configure their availability.',
        }
      }

      if (action === 'check_availability') {
        const slots = await getAvailableSlots(calendar, dateStr)

        if (slots.length === 0) {
          return {
            success: true,
            data: `No available slots on ${dateStr}. The business may be closed or fully booked on this day.`,
          }
        }

        const slotList = slots.map((s) => `• ${s}`).join('\n')
        return {
          success: true,
          data: `Available slots on ${dateStr}:\n${slotList}\n\nPlease ask the customer which time works best for them.`,
        }
      }

      if (action === 'book') {
        const time = params.time as string
        const title = (params.title as string) ?? 'Appointment'
        const notes = (params.notes as string) ?? ''

        if (!time) {
          return { success: false, data: 'Time is required for booking. Ask the customer to pick a time slot.' }
        }

        // Parse the date and time into start/end timestamps
        const startDate = new Date(`${dateStr}T${time}:00`)
        if (isNaN(startDate.getTime())) {
          return { success: false, data: `Invalid date/time: ${dateStr} ${time}` }
        }

        const durationMs = (calendar.slot_duration_minutes ?? 30) * 60 * 1000
        const endDate = new Date(startDate.getTime() + durationMs)

        // Check for conflicts
        const { data: conflicts } = await db
          .from('ai_appointments')
          .select('id')
          .eq('calendar_id', calendar.id)
          .neq('status', 'cancelled')
          .lt('starts_at', endDate.toISOString())
          .gt('ends_at', startDate.toISOString())
          .limit(1)

        if (conflicts && conflicts.length > 0) {
          return {
            success: false,
            data: `The ${time} slot on ${dateStr} is no longer available. Please check availability again for updated slots.`,
          }
        }

        // Book the appointment
        const { data: appointment, error } = await db
          .from('ai_appointments')
          .insert({
            calendar_id: calendar.id,
            contact_id: context.contactId,
            agent_id: context.agentId,
            conversation_id: context.conversationId,
            title,
            starts_at: startDate.toISOString(),
            ends_at: endDate.toISOString(),
            status: 'confirmed',
            notes,
          })
          .select('id, title, starts_at, ends_at')
          .single()

        if (error) {
          return {
            success: false,
            data: `Failed to book appointment: ${error.message}`,
          }
        }

        // --- Push to Google Calendar if connected ---
        try {
          const { data: gcalAccount } = await db
            .from('connected_accounts')
            .select('*')
            .eq('account_id', context.accountId)
            .eq('provider', 'google')
            .single()

          if (gcalAccount && gcalAccount.refresh_token) {
            // Import google dynamically to avoid cold start overhead if not used
            const { google } = await import('googleapis')
            const oauth2Client = new google.auth.OAuth2(
              process.env.GOOGLE_CLIENT_ID,
              process.env.GOOGLE_CLIENT_SECRET
            )
            oauth2Client.setCredentials({
              access_token: gcalAccount.access_token,
              refresh_token: gcalAccount.refresh_token
            })

            const calendarApi = google.calendar({ version: 'v3', auth: oauth2Client })
            
            await calendarApi.events.insert({
              calendarId: 'primary',
              requestBody: {
                summary: title,
                description: notes || 'Booked via AI Agent',
                start: { dateTime: startDate.toISOString() },
                end: { dateTime: endDate.toISOString() }
              }
            })
            
            // Note: If tokens refresh during this call, we ideally should save them back to DB,
            // but the googleapis library handles auto-refresh internally if refresh_token is set.
            // For a robust production app, listen to oauth2Client.on('tokens', ...) and update DB.
          }
        } catch (gcalErr) {
          console.error("Failed to sync with Google Calendar:", gcalErr)
          // We don't fail the AI booking if GCal sync fails, but we log it
        }
        // ---------------------------------------------

        const formattedDate = startDate.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
        const formattedTime = startDate.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        })

        return {
          success: true,
          data:
            `Appointment booked successfully!\n` +
            `📅 ${formattedDate}\n` +
            `🕐 ${formattedTime}\n` +
            `📝 ${title}\n` +
            `The customer has been confirmed.`,
          metadata: { appointment_id: appointment.id },
        }
      }

      return { success: false, data: `Unknown action: ${action}` }
    } catch (err) {
      return {
        success: false,
        data: `Booking failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}

// ============================================================
// Helpers
// ============================================================

/**
 * Get available time slots for a given date based on the calendar's
 * working hours and existing appointments.
 */
async function getAvailableSlots(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calendar: any,
  dateStr: string,
): Promise<string[]> {
  const db = supabaseAdmin()
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return []

  // Get the day of week
  const dayKey = DAY_KEYS[date.getDay()]
  const workingHours = calendar.working_hours as Record<string, [string, string]>
  const dayHours = workingHours[dayKey]

  if (!dayHours) return [] // Closed on this day

  const [openTime, closeTime] = dayHours
  const slotMinutes = calendar.slot_duration_minutes ?? 30
  const bufferMinutes = calendar.buffer_minutes ?? 0

  // Parse open/close times
  const [openH, openM] = openTime.split(':').map(Number)
  const [closeH, closeM] = closeTime.split(':').map(Number)
  const openMinutes = openH * 60 + openM
  const closeMinutes = closeH * 60 + closeM

  // Get existing appointments for this day
  const dayStart = new Date(`${dateStr}T00:00:00`)
  const dayEnd = new Date(`${dateStr}T23:59:59`)

  const { data: appointments } = await db
    .from('ai_appointments')
    .select('starts_at, ends_at')
    .eq('calendar_id', calendar.id)
    .neq('status', 'cancelled')
    .gte('starts_at', dayStart.toISOString())
    .lte('starts_at', dayEnd.toISOString())

  // Build set of booked time ranges
  const bookedRanges = (appointments ?? []).map(
    (a: { starts_at: string; ends_at: string }) => ({
      start: new Date(a.starts_at).getTime(),
      end: new Date(a.ends_at).getTime(),
    }),
  )

  // Generate available slots
  const slots: string[] = []
  let currentMinute = openMinutes

  while (currentMinute + slotMinutes <= closeMinutes) {
    const slotStart = new Date(dateStr)
    slotStart.setHours(Math.floor(currentMinute / 60), currentMinute % 60, 0, 0)
    const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60 * 1000)

    // Check for conflicts
    const hasConflict = bookedRanges.some(
      (r: { start: number; end: number }) =>
        slotStart.getTime() < r.end && slotEnd.getTime() > r.start,
    )

    // Skip past slots (if checking today)
    const now = new Date()
    const isPast =
      dateStr === now.toISOString().split('T')[0] && slotStart < now

    if (!hasConflict && !isPast) {
      const timeStr = `${String(slotStart.getHours()).padStart(2, '0')}:${String(slotStart.getMinutes()).padStart(2, '0')}`
      slots.push(timeStr)
    }

    currentMinute += slotMinutes + bufferMinutes
  }

  return slots
}
