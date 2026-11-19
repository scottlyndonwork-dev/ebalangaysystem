import { describe, expect, it } from 'vitest';
import { OrderStatus, OrderType } from './enums.js';
import {
  canTransition,
  findTransition,
  isTerminalStatus,
  nextStatuses,
  OrderActor,
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
} from './order-state-machine.js';

type Scope = 'all' | 'delivery' | 'pos';

/**
 * Written independently of the implementation: "from > to : actors [scope]".
 * delivery = every order type except pos; pos = pos only.
 */
const EXPECTED = `
pending_payment > placed : system
pending_payment > cancelled : customer system admin
pending_payment > failed : system
placed > confirmed : merchant system
placed > cancelled : customer merchant system admin
confirmed > preparing : merchant
confirmed > rider_assigned : system admin [delivery]
confirmed > cancelled : customer merchant admin
confirmed > failed : system admin
preparing > ready : merchant
preparing > rider_assigned : system admin [delivery]
preparing > cancelled : customer merchant admin
preparing > failed : system admin
ready > rider_assigned : system admin [delivery]
ready > delivered : merchant [pos]
ready > cancelled : merchant admin
ready > failed : system admin
rider_assigned > rider_at_merchant : rider
rider_assigned > cancelled : merchant admin
rider_assigned > failed : system admin
rider_at_merchant > picked_up : rider
rider_at_merchant > cancelled : merchant admin
rider_at_merchant > failed : system admin
picked_up > on_the_way : rider
picked_up > failed : rider system admin
on_the_way > rider_nearby : rider system
on_the_way > delivered : rider admin
on_the_way > failed : rider system admin
rider_nearby > delivered : rider admin
rider_nearby > failed : rider system admin
`
  .trim()
  .split('\n')
  .map((line) => {
    const m = /^(\w+) > (\w+) : ([\w ]+?)(?: \[(\w+)\])?$/.exec(line.trim());
    if (!m) throw new Error(`bad spec line: ${line}`);
    return {
      from: m[1] as OrderStatus,
      to: m[2] as OrderStatus,
      actors: (m[3] ?? '').split(' ') as OrderActor[],
      scope: (m[4] ?? 'all') as Scope,
    };
  });

const STATUSES = Object.values(OrderStatus);
const ACTORS = Object.values(OrderActor);
const TYPES = Object.values(OrderType);

function expected(from: OrderStatus, to: OrderStatus, actor: OrderActor, type: OrderType) {
  const row = EXPECTED.find((r) => r.from === from && r.to === to);
  if (!row || !row.actors.includes(actor)) return false;
  if (row.scope === 'pos') return type === OrderType.POS;
  if (row.scope === 'delivery') return type !== OrderType.POS;
  return true;
}

describe('order state machine', () => {
  it('spec and implementation list the same transitions', () => {
    const key = (t: { from: string; to: string }) => `${t.from}>${t.to}`;
    expect(ORDER_TRANSITIONS.map(key).sort()).toEqual(EXPECTED.map(key).sort());
    expect(new Set(ORDER_TRANSITIONS.map(key)).size).toBe(ORDER_TRANSITIONS.length);
  });

  it('matches the spec for every (from, to, actor, orderType) combination', () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const from of STATUSES)
      for (const to of STATUSES)
        for (const actor of ACTORS)
          for (const orderType of TYPES) {
            checked++;
            const want = expected(from, to, actor, orderType);
            if (canTransition(from, to, actor, { orderType }) !== want) {
              mismatches.push(`${from} > ${to} by ${actor} (${orderType}) should be ${want}`);
            }
          }
    expect(checked).toBe(13 * 13 * 5 * 7);
    expect(mismatches).toEqual([]);
  });

  it('defaults to a regular delivery order when no context is given', () => {
    expect(canTransition('ready', 'rider_assigned', 'system')).toBe(true);
    expect(canTransition('ready', 'delivered', 'merchant')).toBe(false);
  });

  it('terminal statuses have no outgoing transitions', () => {
    expect(TERMINAL_ORDER_STATUSES).toEqual(['delivered', 'cancelled', 'failed']);
    for (const s of STATUSES) {
      expect(isTerminalStatus(s)).toBe(TERMINAL_ORDER_STATUSES.includes(s));
    }
    for (const s of TERMINAL_ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS.filter((t) => t.from === s)).toEqual([]);
    }
  });

  it('never allows self-transitions', () => {
    for (const s of STATUSES) expect(findTransition(s, s)).toBeUndefined();
  });

  it('customers can cancel until the order is ready', () => {
    const allowed = STATUSES.filter((s) => canTransition(s, 'cancelled', 'customer'));
    expect(allowed).toEqual(['pending_payment', 'placed', 'confirmed', 'preparing']);
  });

  it('every status is reachable from pending_payment and can reach a terminal status', () => {
    const reachable = new Set<OrderStatus>(['pending_payment']);
    for (let changed = true; changed;) {
      changed = false;
      for (const t of ORDER_TRANSITIONS) {
        if (reachable.has(t.from) && !reachable.has(t.to)) {
          reachable.add(t.to);
          changed = true;
        }
      }
    }
    expect([...reachable].sort()).toEqual([...STATUSES].sort());
    for (const s of STATUSES) {
      if (!isTerminalStatus(s)) expect(ORDER_TRANSITIONS.some((t) => t.from === s)).toBe(true);
    }
  });

  it('nextStatuses lists the allowed targets for an actor', () => {
    expect(nextStatuses('placed', 'merchant')).toEqual(['confirmed', 'cancelled']);
    expect(nextStatuses('ready', 'merchant', { orderType: 'pos' })).toEqual([
      'delivered',
      'cancelled',
    ]);
    expect(nextStatuses('ready', 'system')).toEqual(['rider_assigned', 'failed']);
    expect(nextStatuses('ready', 'system', { orderType: 'pos' })).toEqual(['failed']);
    expect(nextStatuses('delivered', 'admin')).toEqual([]);
  });
});
