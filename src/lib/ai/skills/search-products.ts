import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'

export const searchProductsSkill: SkillDefinition = {
  type: 'search_products',
  tool: {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Search the inventory/database for available products. ' +
        'Use this to see what items are in stock, their prices, and descriptions BEFORE you decide to send a product photo. ' +
        'This tool returns a text list of products. It DOES NOT send a message to the customer.',
      parameters: {
        type: 'object',
        properties: {
          search_query: {
            type: 'string',
            description: 'Keywords to search for (e.g., "dress", "shoes", "red"). Use empty string to list all.',
          },
        },
        required: ['search_query'],
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()
    const searchQuery = (params.search_query as string) ?? ''

    try {
      let query = db.from('products').select('name, price, description').eq('account_id', context.accountId)

      if (searchQuery.trim() !== '') {
        query = query.or(`name.ilike.%${searchQuery}%,description.ilike.%${searchQuery}%`)
      }

      const { data: products, error } = await query.limit(10)

      if (error) {
        throw new Error(error.message)
      }

      if (!products || products.length === 0) {
        return {
          success: true,
          data: `No products found matching "${searchQuery}".`,
        }
      }

      const productList = products
        .map((p, i) => `${i + 1}. ${p.name} - ${p.price}\n   Description: ${p.description || 'N/A'}`)
        .join('\n\n')

      return {
        success: true,
        data: `Found ${products.length} products:\n\n${productList}\n\nYou can now use send_product with a specific product name to send a photo to the customer.`,
      }
    } catch (err) {
      console.error('[skill/search-products] Error:', err)
      return {
        success: false,
        data: `Failed to search products: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
