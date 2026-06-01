import { Contract, ContractDescription, ContractDetails, Order, OrderState, UNSET_DECIMAL } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { buildContract } from '../contract-builder.js'
import type { OpenOrder } from '../types.js'
import type { KiteInstrument, KiteOrder, KiteOrderType, KitePosition, KiteTransactionType } from './zerodha-types.js'

export const ZERODHA_EXCHANGE = 'NFO'
export const ZERODHA_CURRENCY = 'INR'

export function makeNativeKey(exchange: string, tradingsymbol: string): string {
  return `${exchange}:${tradingsymbol}`
}

export function parseZerodhaNativeKey(nativeKey: string): { exchange: string; tradingsymbol: string } {
  const [exchange, ...rest] = nativeKey.split(':')
  const tradingsymbol = rest.join(':')
  if (!exchange || !tradingsymbol) throw new Error(`Invalid Zerodha native key "${nativeKey}" (expected EXCHANGE:tradingsymbol)`)
  return { exchange, tradingsymbol }
}

export function isIndexOptionInstrument(i: KiteInstrument): boolean {
  return i.exchange === 'NFO' && i.segment === 'NFO-OPT' && (i.instrument_type === 'CE' || i.instrument_type === 'PE')
}

export function kiteInstrumentToContract(i: KiteInstrument): Contract {
  if (!isIndexOptionInstrument(i)) {
    throw new Error(`Unsupported Zerodha instrument ${i.exchange}:${i.tradingsymbol}; MVP supports NFO options only`)
  }
  return buildContract({
    symbol: normalizeUnderlying(i.name, i.tradingsymbol),
    secType: 'OPT',
    exchange: i.exchange,
    currency: ZERODHA_CURRENCY,
    localSymbol: i.tradingsymbol,
    lastTradeDateOrContractMonth: formatExpiry(i.expiry),
    strike: i.strike,
    right: i.instrument_type === 'CE' ? 'C' : 'P',
    multiplier: String(i.lot_size || 1),
    conId: i.instrument_token,
    tradingClass: normalizeUnderlying(i.name, i.tradingsymbol),
    description: `${normalizeUnderlying(i.name, i.tradingsymbol)} ${i.expiry ?? ''} ${i.strike ?? ''} ${i.instrument_type}`.trim(),
  })
}

export function makeContractDescription(i: KiteInstrument): ContractDescription {
  const desc = new ContractDescription()
  desc.contract = kiteInstrumentToContract(i)
  desc.derivativeSecTypes = []
  return desc
}

export function makeContractDetails(i: KiteInstrument): ContractDetails {
  const details = new ContractDetails()
  details.contract = kiteInstrumentToContract(i)
  details.marketName = i.name
  details.minTick = i.tick_size
  details.orderTypes = 'MARKET,LIMIT,SL,SL-M'
  details.validExchanges = i.exchange
  details.longName = details.contract.description
  details.contractMonth = formatExpiry(i.expiry).slice(0, 6)
  details.timeZoneId = 'Asia/Kolkata'
  details.underSymbol = normalizeUnderlying(i.name, i.tradingsymbol)
  details.underSecType = 'IND'
  return details
}

export function contractNativeKey(contract: Contract): string {
  if (contract.aliceId && !contract.localSymbol) {
    const parts = contract.aliceId.split('|')
    if (parts[1]) return parts[1]
  }
  if (!contract.exchange || !contract.localSymbol) {
    throw new Error('Zerodha contract requires exchange and localSymbol/tradingsymbol')
  }
  return makeNativeKey(contract.exchange, contract.localSymbol)
}

export function orderFromKite(row: KiteOrder, contract: Contract): OpenOrder {
  const order = new Order()
  order.action = row.transaction_type
  order.orderType = kiteOrderTypeToIbkr(row.order_type)
  order.totalQuantity = new Decimal(row.quantity)
  if (row.price) order.lmtPrice = new Decimal(row.price)
  if (row.trigger_price) order.auxPrice = new Decimal(row.trigger_price)
  order.tif = row.validity
  order.orderRef = row.tag ?? ''
  order.filledQuantity = new Decimal(row.filled_quantity ?? 0)

  const orderState = new OrderState()
  orderState.status = kiteStatusToIbkr(row.status)
  orderState.warningText = row.status_message ?? row.status_message_raw ?? ''

  return {
    contract,
    order,
    orderState,
    avgFillPrice: row.average_price ? String(row.average_price) : undefined,
  }
}

export function kiteStatusToIbkr(status: string): string {
  switch (status.toUpperCase()) {
    case 'COMPLETE': return 'Filled'
    case 'CANCELLED': return 'Cancelled'
    case 'REJECTED': return 'Inactive'
    case 'OPEN':
    case 'TRIGGER PENDING':
    case 'VALIDATION PENDING':
    case 'PUT ORDER REQ RECEIVED':
    case 'OPEN PENDING':
    case 'MODIFY PENDING':
    case 'CANCEL PENDING':
      return 'Submitted'
    default:
      return 'Submitted'
  }
}

export function kiteOrderTypeToIbkr(type: KiteOrderType): string {
  switch (type) {
    case 'MARKET': return 'MKT'
    case 'LIMIT': return 'LMT'
    case 'SL-M': return 'STP'
    case 'SL': return 'STP LMT'
  }
}

export function ibkrOrderTypeToKite(order: Order): KiteOrderType {
  switch (order.orderType) {
    case 'MKT': return 'MARKET'
    case 'LMT': return 'LIMIT'
    case 'STP': return 'SL-M'
    case 'STP LMT': return 'SL'
    default:
      throw new Error(`Unsupported Zerodha orderType "${order.orderType}"; supported: MKT, LMT, STP, STP LMT`)
  }
}

export function toKiteTransactionType(action: string): KiteTransactionType {
  if (action === 'BUY' || action === 'SELL') return action
  throw new Error(`Unsupported Zerodha order action "${action}"; expected BUY or SELL`)
}

export function nativeKeyForPosition(position: KitePosition): string {
  return makeNativeKey(position.exchange, position.tradingsymbol)
}

export function hasDecimal(value: Decimal): boolean {
  return !value.equals(UNSET_DECIMAL)
}

function normalizeUnderlying(name: string, tradingsymbol: string): 'NIFTY' | 'BANKNIFTY' | string {
  const raw = (name || tradingsymbol).toUpperCase()
  if (raw.includes('BANKNIFTY')) return 'BANKNIFTY'
  if (raw.includes('NIFTY')) return 'NIFTY'
  return raw
}

function formatExpiry(expiry: string | undefined): string {
  if (!expiry) throw new Error('Zerodha option instrument missing expiry')
  return expiry.replace(/-/g, '')
}
