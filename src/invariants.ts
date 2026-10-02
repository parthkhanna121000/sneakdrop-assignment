import type { Pool } from 'pg';
import { TOTAL_SNEAKERS } from './config/env';

/**
 * Single statement => single snapshot. Returns a list of violated invariants (empty = healthy).
 * Run it after every important test, or expose it for debugging.
 */
export async function checkInvariants(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query(
    `
    SELECT 'inventory_total_is_not_${TOTAL_SNEAKERS}' AS violation
      WHERE (SELECT COUNT(*) FROM sneakers) <> ${TOTAL_SNEAKERS}
    UNION ALL
    SELECT 'user_has_multiple_active_reservations'
      FROM reservations WHERE status IN ('HELD','PAYMENT_PENDING') GROUP BY user_id HAVING COUNT(*) > 1
    UNION ALL
    SELECT 'user_purchase_count_over_2' FROM users WHERE purchase_count > 2
    UNION ALL
    SELECT 'purchase_count_mismatch'
      FROM users u WHERE u.purchase_count <> (SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id)
    UNION ALL
    SELECT 'pending_payment_without_active_reservation'
      FROM payments p WHERE p.status = 'PENDING'
       AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.id = p.reservation_id AND r.status = 'PAYMENT_PENDING')
    UNION ALL
    SELECT 'held_sneaker_without_exactly_one_active_reservation'
      FROM sneakers s WHERE s.status = 'HELD'
       AND (SELECT COUNT(*) FROM reservations r WHERE r.sneaker_id = s.id AND r.status IN ('HELD','PAYMENT_PENDING')) <> 1
    UNION ALL
    SELECT 'non_held_sneaker_has_active_reservation'
      FROM sneakers s WHERE s.status <> 'HELD'
       AND EXISTS (SELECT 1 FROM reservations r WHERE r.sneaker_id = s.id AND r.status IN ('HELD','PAYMENT_PENDING'))
    UNION ALL
    SELECT 'purchased_sneakers_do_not_match_purchases'
      WHERE (SELECT COUNT(*) FROM sneakers WHERE status = 'PURCHASED') <> (SELECT COUNT(*) FROM purchases)
    UNION ALL
    SELECT 'people_waiting_while_stock_available'
      WHERE EXISTS (SELECT 1 FROM queue_entries WHERE status = 'WAITING')
        AND EXISTS (SELECT 1 FROM sneakers WHERE status = 'AVAILABLE')
    `,
  );
  return rows.map((r) => r.violation as string);
}
