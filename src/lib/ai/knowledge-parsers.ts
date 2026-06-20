/**
 * Knowledge Base Parsers.
 *
 * Extracts text from various sources:
 * - PDF documents (via pdf-parse)
 * - Website URLs (via cheerio)
 * - FAQs (manual JSON/text format)
 */

import * as cheerio from 'cheerio'

// pdf-parse doesn't have great TS support, so we import it dynamically or require it
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse')

/**
 * Extract clean text from a PDF Buffer.
 */
export async function parsePdf(buffer: Buffer): Promise<string> {
  try {
    const data = await pdfParse(buffer)
    // data.text contains the extracted text
    // Replace multiple newlines with single newlines
    return data.text.replace(/\n\s*\n/g, '\n').trim()
  } catch (err) {
    console.error('[ai/parsers] PDF parse error:', err)
    throw new Error('Failed to parse PDF document. It may be encrypted or corrupted.')
  }
}

/**
 * Fetch and extract main body text from a webpage URL.
 */
export async function scrapeUrl(url: string): Promise<string> {
  try {
    // Basic validation
    new URL(url)

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WhatsAppCRM-Bot/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const html = await response.text()
    const $ = cheerio.load(html)

    // Remove noise elements
    $('script, style, nav, footer, header, aside, iframe, noscript').remove()

    // Extract text from the main body or article
    const content = $('main, article, .content, #content, body').text()

    // Clean up whitespace: replace multiple spaces/newlines with a single space/newline
    return content
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim()
  } catch (err) {
    console.error('[ai/parsers] URL scrape error:', err)
    throw new Error(`Failed to scrape URL: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Format a list of Q&A pairs into a single readable string for the LLM.
 */
export function formatFaq(faqs: { question: string; answer: string }[]): string {
  return faqs
    .filter(f => f.question.trim() && f.answer.trim())
    .map(f => `Q: ${f.question.trim()}\nA: ${f.answer.trim()}`)
    .join('\n\n')
}
