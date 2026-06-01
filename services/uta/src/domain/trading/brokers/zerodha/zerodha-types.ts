export type KiteExchange = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'CDS' | 'BCD' | 'MCX'
export type KiteOrderVariety = 'regular' | 'amo' | 'co' | 'iceberg' | 'auction'
export type KiteProduct = 'CNC' | 'NRML' | 'MIS' | 'MTF'
export type KiteValidity = 'DAY' | 'IOC' | 'TTL'
export type KiteTransactionType = 'BUY' | 'SELL'
export type KiteOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
export type ZerodhaUnderlying = 'NIFTY' | 'BANKNIFTY'

export interface ZerodhaBrokerConfig {
  id?: string
  label?: string
  apiKey: string
  accessToken: string
  defaultProduct: 'NRML' | 'MIS'
  defaultVariety: 'regular'
  defaultValidity: 'DAY' | 'IOC'
  autoslice: boolean
  marketProtection?: number | 'auto'
  enabledUnderlyings: ZerodhaUnderlying[]
  refreshInstrumentsAtStartup: boolean
  baseUrl?: string
}

export interface KiteApiResponse<T> {
  status: 'success' | 'error'
  data: T
  message?: string
  error_type?: string
}

export interface KiteProfile {
  user_id: string
  user_name?: string
  email?: string
  broker?: string
  exchanges?: string[]
  products?: string[]
  order_types?: string[]
}

export interface KiteMarginsSegment {
  enabled?: boolean
  net?: number
  available?: {
    adhoc_margin?: number
    cash?: number
    opening_balance?: number
    live_balance?: number
    collateral?: number
    intraday_payin?: number
  }
  utilised?: {
    debits?: number
    exposure?: number
    m2m_realised?: number
    m2m_unrealised?: number
    option_premium?: number
    payout?: number
    span?: number
    holding_sales?: number
    turnover?: number
    liquid_collateral?: number
    stock_collateral?: number
  }
}

export interface KiteMargins {
  equity?: KiteMarginsSegment
  commodity?: KiteMarginsSegment
}

export interface KiteInstrument {
  instrument_token: number
  exchange_token: string
  tradingsymbol: string
  name: string
  last_price: number
  expiry?: string
  strike?: number
  tick_size: number
  lot_size: number
  instrument_type: 'EQ' | 'FUT' | 'CE' | 'PE'
  segment: string
  exchange: KiteExchange
}

export interface KitePosition {
  tradingsymbol: string
  exchange: KiteExchange
  instrument_token: number
  product: KiteProduct
  quantity: number
  overnight_quantity?: number
  multiplier?: number
  average_price: number
  close_price?: number
  last_price: number
  value?: number
  pnl: number
  m2m?: number
  unrealised?: number
  realised?: number
  buy_quantity?: number
  sell_quantity?: number
}

export interface KitePositionsResponse {
  net: KitePosition[]
  day: KitePosition[]
}

export interface KiteOrder {
  order_id: string
  exchange_order_id?: string | null
  parent_order_id?: string | null
  status: string
  status_message?: string | null
  status_message_raw?: string | null
  order_timestamp?: string | null
  exchange_update_timestamp?: string | null
  exchange_timestamp?: string | null
  variety: KiteOrderVariety
  exchange: KiteExchange
  tradingsymbol: string
  instrument_token?: number
  order_type: KiteOrderType
  transaction_type: KiteTransactionType
  validity: KiteValidity
  product: KiteProduct
  quantity: number
  price: number
  trigger_price: number
  average_price: number
  filled_quantity: number
  pending_quantity: number
  cancelled_quantity?: number
  tag?: string | null
}

export interface KiteQuoteDepthLevel {
  price: number
  quantity: number
  orders: number
}

export interface KiteQuote {
  instrument_token: number
  timestamp?: string
  last_trade_time?: string
  last_price: number
  last_quantity?: number
  buy_quantity?: number
  sell_quantity?: number
  volume?: number
  average_price?: number
  oi?: number
  oi_day_high?: number
  oi_day_low?: number
  net_change?: number
  lower_circuit_limit?: number
  upper_circuit_limit?: number
  ohlc?: { open?: number; high?: number; low?: number; close?: number }
  depth?: {
    buy?: KiteQuoteDepthLevel[]
    sell?: KiteQuoteDepthLevel[]
  }
}

export interface KitePlaceOrder {
  tradingsymbol: string
  exchange: KiteExchange
  transaction_type: KiteTransactionType
  order_type: KiteOrderType
  quantity: string
  product: KiteProduct
  validity: KiteValidity
  price?: string
  trigger_price?: string
  market_protection?: string
  autoslice?: 'true' | 'false'
  tag?: string
}

export interface KiteModifyOrder {
  order_type?: KiteOrderType
  quantity?: string
  price?: string
  trigger_price?: string
  validity?: KiteValidity
}
