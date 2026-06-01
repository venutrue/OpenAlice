import { BrokerError } from '../types.js'
import type {
  KiteApiResponse,
  KiteExchange,
  KiteInstrument,
  KiteMargins,
  KiteModifyOrder,
  KiteOrder,
  KitePlaceOrder,
  KitePositionsResponse,
  KiteProfile,
  KiteQuote,
} from './zerodha-types.js'

export interface ZerodhaClientConfig {
  apiKey: string
  accessToken: string
  baseUrl?: string
}

export class ZerodhaClient {
  private readonly baseUrl: string

  constructor(private readonly cfg: ZerodhaClientConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://api.kite.trade'
  }

  profile(): Promise<KiteProfile> {
    return this.getJson<KiteProfile>('/user/profile')
  }

  margins(segment?: 'equity' | 'commodity'): Promise<KiteMargins | KiteMargins[keyof KiteMargins]> {
    return this.getJson(segment ? `/user/margins/${segment}` : '/user/margins')
  }

  positions(): Promise<KitePositionsResponse> {
    return this.getJson<KitePositionsResponse>('/portfolio/positions')
  }

  orders(): Promise<KiteOrder[]> {
    return this.getJson<KiteOrder[]>('/orders')
  }

  orderHistory(orderId: string): Promise<KiteOrder[]> {
    return this.getJson<KiteOrder[]>(`/orders/${encodeURIComponent(orderId)}`)
  }

  quote(instruments: string[]): Promise<Record<string, KiteQuote>> {
    const qs = new URLSearchParams()
    for (const i of instruments) qs.append('i', i)
    return this.getJson<Record<string, KiteQuote>>(`/quote?${qs}`)
  }

  async instruments(exchange?: KiteExchange): Promise<KiteInstrument[]> {
    const text = await this.requestText(`/instruments${exchange ? `/${exchange}` : ''}`)
    return parseInstrumentsCsv(text)
  }

  placeOrder(variety: string, body: KitePlaceOrder): Promise<{ order_id: string }> {
    return this.postForm<{ order_id: string }>(`/orders/${encodeURIComponent(variety)}`, body)
  }

  modifyOrder(variety: string, orderId: string, body: KiteModifyOrder): Promise<{ order_id: string }> {
    return this.putForm<{ order_id: string }>(`/orders/${encodeURIComponent(variety)}/${encodeURIComponent(orderId)}`, body)
  }

  cancelOrder(variety: string, orderId: string): Promise<{ order_id: string }> {
    return this.deleteJson<{ order_id: string }>(`/orders/${encodeURIComponent(variety)}/${encodeURIComponent(orderId)}`)
  }

  private async getJson<T>(path: string): Promise<T> {
    return this.parseJson<T>(await this.fetch(path))
  }

  private async postForm<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.parseJson<T>(await this.fetch(path, { method: 'POST', body: formBody(body) }))
  }

  private async putForm<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.parseJson<T>(await this.fetch(path, { method: 'PUT', body: formBody(body) }))
  }

  private async deleteJson<T>(path: string): Promise<T> {
    return this.parseJson<T>(await this.fetch(path, { method: 'DELETE' }))
  }

  private async requestText(path: string): Promise<string> {
    const res = await this.fetch(path)
    return res.text()
  }

  private async parseJson<T>(res: Response): Promise<T> {
    const json = await res.json() as KiteApiResponse<T>
    if (json.status === 'error') {
      throw new BrokerError(classifyKiteError(json.error_type, json.message), json.message ?? json.error_type ?? 'Kite API error')
    }
    return json.data
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('X-Kite-Version', '3')
    headers.set('Authorization', `token ${this.cfg.apiKey}:${this.cfg.accessToken}`)
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/x-www-form-urlencoded')
    }

    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new BrokerError(classifyHttpStatus(res.status), text || `Kite API request failed (${res.status})`)
    }
    return res
  }
}

function formBody(body: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  return params
}

function classifyHttpStatus(status: number): 'AUTH' | 'NETWORK' | 'EXCHANGE' {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429 || status >= 500) return 'NETWORK'
  return 'EXCHANGE'
}

function classifyKiteError(errorType?: string, message?: string): 'AUTH' | 'NETWORK' | 'EXCHANGE' | 'MARKET_CLOSED' {
  const text = `${errorType ?? ''} ${message ?? ''}`.toLowerCase()
  if (/token|permission|api key|auth|session|login/.test(text)) return 'AUTH'
  if (/network|timeout|rate|too many/.test(text)) return 'NETWORK'
  if (/market.?closed|outside.?trading/.test(text)) return 'MARKET_CLOSED'
  return 'EXCHANGE'
}

export function parseInstrumentsCsv(csv: string): KiteInstrument[] {
  const rows = parseCsv(csv.trim())
  if (rows.length === 0) return []
  const headers = rows[0] ?? []
  return rows.slice(1).filter(r => r.length > 1).map((row) => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) obj[headers[i] ?? String(i)] = row[i] ?? ''
    return {
      instrument_token: Number(obj['instrument_token'] ?? 0),
      exchange_token: obj['exchange_token'] ?? '',
      tradingsymbol: obj['tradingsymbol'] ?? '',
      name: obj['name'] ?? '',
      last_price: Number(obj['last_price'] ?? 0),
      expiry: obj['expiry'] || undefined,
      strike: obj['strike'] ? Number(obj['strike']) : undefined,
      tick_size: Number(obj['tick_size'] ?? 0),
      lot_size: Number(obj['lot_size'] ?? 1),
      instrument_type: (obj['instrument_type'] ?? '') as KiteInstrument['instrument_type'],
      segment: obj['segment'] ?? '',
      exchange: (obj['exchange'] ?? '') as KiteExchange,
    }
  })
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]
    const next = csv[i + 1]
    if (quoted) {
      if (ch === '"' && next === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  row.push(field)
  rows.push(row)
  return rows
}
