import { z } from 'zod'
import Decimal from 'decimal.js'
import { Contract, ContractDetails, Order, OrderState, UNSET_DECIMAL } from '@traderalice/ibkr'
import {
  BrokerError,
  type AccountCapabilities,
  type AccountInfo,
  type IBroker,
  type MarketClock,
  type OpenOrder,
  type PlaceOrderResult,
  type Position,
  type Quote,
  type TpSlParams,
} from '../types.js'
import { buildPosition } from '../contract-builder.js'
import { ZerodhaClient } from './zerodha-client.js'
import type { KiteInstrument, KiteOrder, KitePlaceOrder, KiteProduct, KiteQuote, ZerodhaBrokerConfig } from './zerodha-types.js'
import {
  contractNativeKey,
  hasDecimal,
  ibkrOrderTypeToKite,
  isIndexOptionInstrument,
  kiteInstrumentToContract,
  makeContractDescription,
  makeContractDetails,
  makeNativeKey,
  nativeKeyForPosition,
  orderFromKite,
  parseZerodhaNativeKey,
  toKiteTransactionType,
} from './zerodha-contracts.js'

export class ZerodhaBroker implements IBroker {
  static configSchema = z.object({
    apiKey: z.string().min(1),
    accessToken: z.string().min(1),
    defaultProduct: z.enum(['NRML', 'MIS']).default('NRML'),
    defaultVariety: z.literal('regular').default('regular'),
    defaultValidity: z.enum(['DAY', 'IOC']).default('DAY'),
    autoslice: z.boolean().default(true),
    marketProtection: z.union([z.number().min(0).max(100), z.literal('auto')]).optional(),
    enabledUnderlyings: z.array(z.enum(['NIFTY', 'BANKNIFTY'])).default(['NIFTY', 'BANKNIFTY']),
    refreshInstrumentsAtStartup: z.boolean().default(true),
    baseUrl: z.string().optional(),
  })

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): ZerodhaBroker {
    const bc = ZerodhaBroker.configSchema.parse(config.brokerConfig)
    return new ZerodhaBroker({ id: config.id, label: config.label, ...bc })
  }

  readonly id: string
  readonly label: string
  private readonly cfg: ZerodhaBrokerConfig
  private readonly client: ZerodhaClient
  private instrumentsByKey = new Map<string, KiteInstrument>()
  private optionInstruments: KiteInstrument[] = []
  private fallbackContracts = new Map<string, Contract>()

  constructor(cfg: ZerodhaBrokerConfig) {
    this.cfg = cfg
    this.id = cfg.id ?? 'zerodha-kite'
    this.label = cfg.label ?? 'Zerodha Kite'
    this.client = new ZerodhaClient({ apiKey: cfg.apiKey, accessToken: cfg.accessToken, baseUrl: cfg.baseUrl })
  }

  async init(): Promise<void> {
    if (!this.cfg.apiKey || !this.cfg.accessToken) {
      throw new BrokerError('CONFIG', 'Zerodha requires apiKey and daily accessToken')
    }
    await this.client.profile()
    if (this.cfg.refreshInstrumentsAtStartup) await this.refreshCatalog()
  }

  async close(): Promise<void> {}

  async refreshCatalog(): Promise<void> {
    const instruments = await this.client.instruments('NFO')
    const enabled = new Set(this.cfg.enabledUnderlyings)
    const options = instruments.filter(i => isIndexOptionInstrument(i) && enabled.has((i.name || '').toUpperCase() as 'NIFTY' | 'BANKNIFTY'))
    const byKey = new Map<string, KiteInstrument>()
    for (const i of options) byKey.set(makeNativeKey(i.exchange, i.tradingsymbol), i)
    this.optionInstruments = options
    this.instrumentsByKey = byKey
  }

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    await this.ensureCatalog()
    const terms = pattern.toUpperCase().split(/\s+/).filter(Boolean)
    const matches = this.optionInstruments
      .filter(i => matchesSearch(i, terms, pattern))
      .sort((a, b) => sortInstrument(a, b))
      .slice(0, 50)
    return matches.map(makeContractDescription)
  }

  async getContractDetails(query: Contract): Promise<ContractDetails | null> {
    await this.ensureCatalog()
    const instrument = this.resolveInstrument(query)
    return instrument ? makeContractDetails(instrument) : null
  }

  async placeOrder(contract: Contract, order: Order, tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    if (tpsl?.takeProfit || tpsl?.stopLoss) {
      return { success: false, error: 'Zerodha MVP does not support attached take-profit/stop-loss orders; stage separate exit orders instead.' }
    }
    try {
      await this.ensureCatalog()
      const resolved = this.resolveTradeContract(contract)
      const body = this.makePlaceOrderBody(resolved, order)
      const { order_id } = await this.client.placeOrder(this.cfg.defaultVariety, body)
      const orderState = new OrderState()
      orderState.status = 'Submitted'
      return { success: true, orderId: order_id, orderState, message: 'Zerodha order submitted; poll order status for execution state.' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  async modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult> {
    try {
      const body: Record<string, string> = {}
      if (changes.orderType) body.order_type = ibkrOrderTypeToKite(changes as Order)
      if (changes.totalQuantity && !changes.totalQuantity.equals(UNSET_DECIMAL)) body.quantity = changes.totalQuantity.toFixed()
      if (changes.tif) body.validity = this.mapTif(changes.tif)
      if (changes.lmtPrice && hasDecimal(changes.lmtPrice)) body.price = changes.lmtPrice.toString()
      if (changes.auxPrice && hasDecimal(changes.auxPrice)) body.trigger_price = changes.auxPrice.toString()
      const res = await this.client.modifyOrder(this.cfg.defaultVariety, orderId, body)
      const orderState = new OrderState()
      orderState.status = 'Submitted'
      return { success: true, orderId: res.order_id, orderState }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async cancelOrder(orderId: string): Promise<PlaceOrderResult> {
    try {
      const res = await this.client.cancelOrder(this.cfg.defaultVariety, orderId)
      const orderState = new OrderState()
      orderState.status = 'Cancelled'
      return { success: true, orderId: res.order_id, orderState }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    const positions = await this.getPositions()
    const key = this.getNativeKey(contract)
    const position = positions.find(p => this.getNativeKey(p.contract) === key)
    if (!position) return { success: false, error: `No open Zerodha position for ${key}` }
    const order = new Order()
    order.action = position.side === 'long' ? 'SELL' : 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = quantity ?? position.quantity
    return this.placeOrder(position.contract, order)
  }

  async getAccount(): Promise<AccountInfo> {
    const margins = await this.client.margins('equity') as NonNullable<Awaited<ReturnType<ZerodhaClient['margins']>>>
    const equity = 'equity' in margins ? margins.equity : margins
    const available = equity?.available ?? {}
    const utilised = equity?.utilised ?? {}
    const marginReq = num(utilised.span) + num(utilised.exposure)
    return {
      baseCurrency: 'INR',
      netLiquidation: String(num(equity?.net)),
      totalCashValue: String(num(available.live_balance ?? available.cash)),
      unrealizedPnL: String(num(utilised.m2m_unrealised)),
      realizedPnL: String(num(utilised.m2m_realised)),
      buyingPower: String(num(available.live_balance ?? available.cash ?? equity?.net)),
      initMarginReq: String(marginReq),
      maintMarginReq: String(marginReq),
    }
  }

  async getPositions(): Promise<Position[]> {
    await this.ensureCatalog()
    const positions = await this.client.positions()
    return positions.net
      .filter(p => p.exchange === 'NFO' && p.quantity !== 0)
      .map((p) => {
        const instrument = this.instrumentsByKey.get(nativeKeyForPosition(p))
        const contract = instrument ? kiteInstrumentToContract(instrument) : this.contractFromPosition(p)
        return buildPosition({
          contract,
          currency: 'INR',
          side: p.quantity >= 0 ? 'long' : 'short',
          quantity: new Decimal(Math.abs(p.quantity)),
          avgCost: String(p.average_price ?? 0),
          marketPrice: String(p.last_price ?? 0),
          realizedPnL: String(p.realised ?? 0),
          unrealizedPnL: String(p.unrealised ?? p.pnl ?? 0),
          marketValue: p.value !== undefined ? String(Math.abs(p.value)) : undefined,
          multiplier: contract.multiplier,
        })
      })
  }

  async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
    const all = await this.client.orders()
    const wanted = orderIds.length ? new Set(orderIds) : null
    return all.filter(o => !wanted || wanted.has(o.order_id)).map(o => this.openOrderFromKite(o))
  }

  async getOrder(orderId: string): Promise<OpenOrder | null> {
    const orders = await this.getOrders([orderId])
    return orders[0] ?? null
  }

  async getQuote(contract: Contract): Promise<Quote> {
    await this.ensureCatalog()
    const resolved = this.resolveTradeContract(contract)
    const key = this.getNativeKey(resolved)
    const quotes = await this.client.quote([key])
    const quote = quotes[key]
    if (!quote) throw new BrokerError('EXCHANGE', `No Zerodha quote returned for ${key}`)
    return this.quoteFromKite(resolved, quote)
  }

  async getMarketClock(): Promise<MarketClock> {
    const now = new Date()
    const { open, close, isOpen } = indiaSession(now)
    return { isOpen, nextOpen: open, nextClose: close, timestamp: now }
  }

  getCapabilities(): AccountCapabilities {
    return {
      supportedSecTypes: ['OPT'],
      supportedOrderTypes: ['MKT', 'LMT', 'STP', 'STP LMT'],
    }
  }

  getNativeKey(contract: Contract): string {
    return contractNativeKey(contract)
  }

  resolveNativeKey(nativeKey: string): Contract {
    const instrument = this.instrumentsByKey.get(nativeKey)
    if (instrument) return kiteInstrumentToContract(instrument)
    const remembered = this.fallbackContracts.get(nativeKey)
    if (remembered) return remembered
    const { exchange, tradingsymbol } = parseZerodhaNativeKey(nativeKey)
    const c = new Contract()
    c.exchange = exchange
    c.localSymbol = tradingsymbol
    c.symbol = tradingsymbol.includes('BANKNIFTY') ? 'BANKNIFTY' : 'NIFTY'
    c.secType = 'OPT'
    c.currency = 'INR'
    return c
  }

  private async ensureCatalog(): Promise<void> {
    if (this.optionInstruments.length === 0) await this.refreshCatalog()
  }

  private resolveInstrument(contract: Contract): KiteInstrument | undefined {
    const candidates = new Set<string>()
    if (contract.localSymbol && contract.exchange) candidates.add(makeNativeKey(contract.exchange, contract.localSymbol))
    if (contract.aliceId?.includes('|')) candidates.add(contract.aliceId.split('|')[1]!)
    for (const key of candidates) {
      const instrument = this.instrumentsByKey.get(key)
      if (instrument) return instrument
    }
    return undefined
  }

  private resolveTradeContract(contract: Contract): Contract {
    const instrument = this.resolveInstrument(contract)
    const resolved = instrument ? kiteInstrumentToContract(instrument) : contract
    if (resolved.exchange !== 'NFO' || resolved.secType !== 'OPT') {
      throw new BrokerError('CONFIG', 'Zerodha MVP supports only NFO option contracts')
    }
    if (!resolved.localSymbol) throw new BrokerError('CONFIG', 'Zerodha order requires contract.localSymbol/tradingsymbol')
    this.fallbackContracts.set(this.getNativeKey(resolved), resolved)
    return resolved
  }

  private makePlaceOrderBody(contract: Contract, order: Order): KitePlaceOrder {
    if (!order.totalQuantity || order.totalQuantity.equals(UNSET_DECIMAL) || order.totalQuantity.lte(0)) {
      throw new Error('Zerodha order quantity must be positive')
    }
    const orderType = ibkrOrderTypeToKite(order)
    const body: KitePlaceOrder = {
      tradingsymbol: contract.localSymbol,
      exchange: 'NFO',
      transaction_type: toKiteTransactionType(order.action),
      order_type: orderType,
      quantity: order.totalQuantity.toFixed(),
      product: this.cfg.defaultProduct as KiteProduct,
      validity: this.mapTif(order.tif || this.cfg.defaultValidity),
      autoslice: this.cfg.autoslice ? 'true' : undefined,
      market_protection: this.cfg.marketProtection === 'auto' ? '-1' : this.cfg.marketProtection?.toString(),
      tag: `alice-${this.id}`.slice(0, 20),
    }
    if ((orderType === 'LIMIT' || orderType === 'SL') && hasDecimal(order.lmtPrice)) body.price = order.lmtPrice.toString()
    if ((orderType === 'SL' || orderType === 'SL-M') && hasDecimal(order.auxPrice)) body.trigger_price = order.auxPrice.toString()
    if ((orderType === 'LIMIT' || orderType === 'SL') && !body.price) throw new Error(`${order.orderType} requires lmtPrice`)
    if ((orderType === 'SL' || orderType === 'SL-M') && !body.trigger_price) throw new Error(`${order.orderType} requires auxPrice trigger`) 
    return body
  }

  private mapTif(tif: string): 'DAY' | 'IOC' {
    if (!tif || tif === 'DAY') return 'DAY'
    if (tif === 'IOC') return 'IOC'
    throw new Error(`Unsupported Zerodha TIF "${tif}"; supported: DAY, IOC`)
  }

  private openOrderFromKite(row: KiteOrder): OpenOrder {
    const key = makeNativeKey(row.exchange, row.tradingsymbol)
    const instrument = this.instrumentsByKey.get(key)
    const contract = instrument ? kiteInstrumentToContract(instrument) : this.resolveNativeKey(key)
    return orderFromKite(row, contract)
  }

  private contractFromPosition(p: { exchange: string; tradingsymbol: string; instrument_token?: number; multiplier?: number }): Contract {
    const c = this.resolveNativeKey(makeNativeKey(p.exchange, p.tradingsymbol))
    c.conId = p.instrument_token ?? c.conId
    c.multiplier = String(p.multiplier || c.multiplier || 1)
    return c
  }

  private quoteFromKite(contract: Contract, q: KiteQuote): Quote {
    return {
      contract,
      last: String(q.last_price ?? 0),
      bid: String(q.depth?.buy?.[0]?.price ?? q.last_price ?? 0),
      ask: String(q.depth?.sell?.[0]?.price ?? q.last_price ?? 0),
      volume: String(q.volume ?? 0),
      high: q.ohlc?.high !== undefined ? String(q.ohlc.high) : undefined,
      low: q.ohlc?.low !== undefined ? String(q.ohlc.low) : undefined,
      timestamp: q.timestamp ? new Date(q.timestamp) : new Date(),
    }
  }
}

function matchesSearch(i: KiteInstrument, terms: string[], original: string): boolean {
  const text = `${i.exchange}:${i.tradingsymbol} ${i.name} ${i.strike ?? ''} ${i.instrument_type}`.toUpperCase()
  if (terms.length === 0) return true
  if (text.includes(original.toUpperCase())) return true
  return terms.every(t => text.includes(t))
}

function sortInstrument(a: KiteInstrument, b: KiteInstrument): number {
  const expiry = String(a.expiry ?? '').localeCompare(String(b.expiry ?? ''))
  if (expiry !== 0) return expiry
  return (a.strike ?? 0) - (b.strike ?? 0)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function indiaSession(now: Date): { isOpen: boolean; open: Date; close: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const weekday = get('weekday')
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  const mins = hour * 60 + minute
  const weekdayOpen = weekday !== 'Sat' && weekday !== 'Sun'
  const isOpen = weekdayOpen && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30
  const y = get('year')
  const m = get('month')
  const d = get('day')
  return {
    isOpen,
    open: new Date(`${y}-${m}-${d}T03:45:00.000Z`),
    close: new Date(`${y}-${m}-${d}T10:00:00.000Z`),
  }
}
