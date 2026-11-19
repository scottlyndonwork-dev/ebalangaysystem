import { describe, expect, it } from 'vitest';
import { ORDER_STATUS_TONE, palette, semanticColors } from './design/index.js';
import { ERROR_HTTP_STATUS, ErrorCode } from './errors.js';
import {
  createOrderInputSchema,
  listOrdersQuerySchema,
  modifierGroupSchema,
  parseRoom,
  phPhoneSchema,
  polygonSchema,
  Rooms,
  SocketEvent,
  socketEventSchemas,
  voucherSchema,
} from './index.js';

const id = '7d9f6a2e-1c3b-4f5a-9e8d-2b1c0a9f8e7d';

describe('schemas', () => {
  it('validates PH mobile numbers', () => {
    expect(phPhoneSchema.safeParse('+639171234567').success).toBe(true);
    expect(phPhoneSchema.safeParse('09171234567').success).toBe(false);
  });

  it('requires scheduledFor and gift details by order type', () => {
    const base = { cartId: id, addressId: id, paymentMethod: 'gcash' };
    expect(createOrderInputSchema.parse(base).tipCentavos).toBe(0);
    expect(createOrderInputSchema.safeParse({ ...base, type: 'scheduled' }).success).toBe(false);
    expect(createOrderInputSchema.safeParse({ ...base, type: 'gift' }).success).toBe(false);
    expect(createOrderInputSchema.safeParse({ ...base, type: 'pos' }).success).toBe(false);
  });

  it('normalises a single status filter to an array', () => {
    expect(listOrdersQuerySchema.parse({ status: 'placed' }).status).toEqual(['placed']);
  });

  it('enforces modifier min <= max and closed polygons', () => {
    const option = { id, name: 'Extra rice', priceDeltaCentavos: 2000, isAvailable: true };
    const group = { id, name: 'Add-ons', minSelect: 3, maxSelect: 1, options: [option] };
    expect(modifierGroupSchema.safeParse(group).success).toBe(false);
    const p = { lat: 8.95, lng: 125.53 };
    const ring = [p, { lat: 8.96, lng: 125.53 }, { lat: 8.96, lng: 125.54 }];
    expect(polygonSchema.safeParse([...ring, p]).success).toBe(true);
    expect(polygonSchema.safeParse([...ring, { lat: 0, lng: 0 }]).success).toBe(false);
  });

  it('discriminates voucher types', () => {
    const v = voucherSchema.parse({
      id,
      code: 'WELCOME50',
      title: '50 off',
      description: null,
      funding: 'platform',
      merchantId: null,
      minSpendCentavos: 20000,
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-12-31T00:00:00Z',
      usageLimit: null,
      perUserLimit: 1,
      usedCount: 0,
      isActive: true,
      discountType: 'fixed',
      amountCentavos: 5000,
    });
    expect(v.discountType === 'fixed' && v.amountCentavos).toBe(5000);
  });
});

describe('socket contract', () => {
  it('has a payload schema for every event, wrapped in the envelope', () => {
    expect(Object.keys(socketEventSchemas).sort()).toEqual(Object.values(SocketEvent).sort());
    const ok = socketEventSchemas['order.updated'].safeParse({
      eventId: id,
      id,
      version: 3,
      occurredAt: '2026-11-18T03:00:00.000Z',
      data: { status: 'preparing', previousStatus: 'confirmed', actor: 'merchant', etaAt: null },
    });
    expect(ok.success).toBe(true);
    expect(socketEventSchemas['surge.updated'].safeParse({ data: { surgeBps: 1 } }).success).toBe(
      false,
    );
  });

  it('builds and parses room names', () => {
    expect(Rooms.order(id)).toBe(`order:${id}`);
    expect(parseRoom(Rooms.merchant(id))).toEqual({ kind: 'merchant', id });
    expect(parseRoom('admin')).toEqual({ kind: 'admin', id: null });
    expect(parseRoom('order:not-a-uuid')).toBeNull();
  });
});

describe('errors and design', () => {
  it('maps every error code to an HTTP status', () => {
    for (const code of Object.values(ErrorCode)) expect(ERROR_HTTP_STATUS[code]).toBeGreaterThan(0);
  });

  it('keeps brand tokens and gives every status a tone', () => {
    expect(palette.brand[500]).toBe('#1D9E75');
    expect(semanticColors.light.primary).toBe('#1D9E75');
    expect(Object.keys(semanticColors.dark).sort()).toEqual(
      Object.keys(semanticColors.light).sort(),
    );
    expect(Object.keys(ORDER_STATUS_TONE)).toHaveLength(13);
  });
});
