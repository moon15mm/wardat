import { logAgentAction } from '../utils/agent-logger';
import { discoverLeads } from './acquisition-agent';

export interface DiscoveredLead {
  name: string;
  city: string;
  phone: string | null;
  instagram: string | null;
  source: string;
  notes: string;
}

/**
 * Discover REAL flower/gift shops via Google Places (see acquisition-agent).
 *
 * IMPORTANT: this NEVER fabricates businesses or phone numbers. Earlier this file
 * returned hard-coded/AI-hallucinated shops with made-up numbers — dangerous,
 * because the autonomous cycle could message those (real, innocent) numbers.
 * It now returns only what Google Maps actually lists for the city.
 */
export async function discoverFlowerShops(city: string): Promise<DiscoveredLead[]> {
  logAgentAction(`البحث عن متاجر ورد حقيقية في "${city}" عبر خرائط Google...`);
  const leads = await discoverLeads(city);
  logAgentAction(`تم العثور على ${leads.length} متجر حقيقي في "${city}".`);
  return leads.map((l) => ({
    name: l.name,
    city: l.city,
    phone: l.phone || null,
    instagram: l.instagram || null,
    source: l.source,
    notes: l.notes,
  }));
}
