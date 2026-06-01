import { describe, expect, it } from 'vitest'
import { Order } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import {
  ibkrOrderTypeToKite,
  kiteInstrumentToContract,
  makeContractDescription,
  makeNativeKey,
  parseZerodhaNativeKey,
} from './zerodha-contracts.js'
import type { KiteInstrument } from './zerodha-types.js'

const niftyCe: KiteInstrument = {
  instrument_token: 123,
  exchange_token: '456',
  tradingsymbol: 'NIFTY2660425000CE',
  name: 'NIFTY',
  last_price: 0,
  expiry: '2026-06-04',
  strike: 25000,
  tick_size: 0.05,
  lot_size: 75,
  instrument_type: 'CE',
  segment: 'NFO-OPT',
  exchange: 'NFO',
}

const bankNiftyPe: KiteInstrument = {
  ...niftyCe,
  instrument_token: 789,
  tradingsymbol: 'BANKNIFTY2660456000PE',
  name: 'BANKNIFTY',
  strike: 56000,
  lot_size: 35,
  instrument_type: 'PE',
}

describe('Zerodha contract mapping', () => {
  it('maps NIFTY CE instrument into a validated OPT contract', () => {
    const c = kiteInstrumentToContract(niftyCe)
    expect(c.symbol).toBe('NIFTY')
    expect(c.secType).toBe('OPT')
    expect(c.exchange).toBe('NFO')
    expect(c.currency).toBe('INR')
    expect(c.localSymbol).toBe('NIFTY2660425000CE')
    expect(c.lastTradeDateOrContractMonth).toBe('20260604')
    expect(c.strike).toBe(25000)
    expect(c.right).toBe('C')
    expect(c.multiplier).toBe('75')
    expect(c.conId).toBe(123)
  })

  it('maps BANKNIFTY PE instrument into a validated OPT contract', () => {
    const c = kiteInstrumentToContract(bankNiftyPe)
    expect(c.symbol).toBe('BANKNIFTY')
    expect(c.right).toBe('P')
    expect(c.multiplier).toBe('35')
  })

  it('uses exchange plus tradingsymbol as native identity', () => {
    const key = makeNativeKey('NFO', 'BANKNIFTY2660456000PE')
    expect(key).toBe('NFO:BANKNIFTY2660456000PE')
    expect(parseZerodhaNativeKey(key)).toEqual({ exchange: 'NFO', tradingsymbol: 'BANKNIFTY2660456000PE' })
  })

  it('returns contract descriptions for search results', () => {
    const desc = makeContractDescription(niftyCe)
    expect(desc.contract.localSymbol).toBe('NIFTY2660425000CE')
    expect(desc.derivativeSecTypes).toEqual([])
  })
})

describe('Zerodha order mapping', () => {
  it('maps supported IBKR order types to Kite order types', () => {
    const order = new Order()
    order.totalQuantity = new Decimal(75)
    order.orderType = 'MKT'
    expect(ibkrOrderTypeToKite(order)).toBe('MARKET')
    order.orderType = 'LMT'
    expect(ibkrOrderTypeToKite(order)).toBe('LIMIT')
    order.orderType = 'STP'
    expect(ibkrOrderTypeToKite(order)).toBe('SL-M')
    order.orderType = 'STP LMT'
    expect(ibkrOrderTypeToKite(order)).toBe('SL')
  })

  it('rejects unsupported order types before network submission', () => {
    const order = new Order()
    order.orderType = 'TRAIL'
    expect(() => ibkrOrderTypeToKite(order)).toThrow(/Unsupported Zerodha orderType/)
  })
})
